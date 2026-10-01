import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  generateOpaqueToken,
  hashOpaqueToken,
  invitationTokenPattern,
  sessionTokenPattern,
} from "../../netlify/functions/_connector-auth.mjs";
import { createConnectorStore } from "../../netlify/functions/_connector-store.mjs";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const INVITE_EXPIRY = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
const SESSION_EXPIRY = new Date(NOW.getTime() + 30 * 60 * 1000);

function fakePool(options = {}) {
  const calls = [];
  const state = {
    invitation: Object.hasOwn(options, "invitation") ? options.invitation : {
      invitation_hash: "a".repeat(64),
      business_id: "dexters-hats",
      connectors: ["facebook", "instagram"],
      expires_at: INVITE_EXPIRY,
      revoked_at: null,
      used_at: null,
    },
    session: null,
  };
  const client = {
    async query(text, values = []) {
      calls.push({ text, values });
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.includes("FROM growthwise_connector_invitations") && text.includes("FOR UPDATE")) {
        return { rows: state.invitation ? [structuredClone(state.invitation)] : [] };
      }
      if (text.includes("INSERT INTO growthwise_connector_sessions")) {
        state.session = {
          session_hash: values[0], business_id: values[1], connectors: values[2], expires_at: values[3],
          revoked_at: null,
        };
        return { rows: [structuredClone(state.session)] };
      }
      if (text.includes("UPDATE growthwise_connector_invitations") && text.includes("used_at")) {
        if (!state.invitation || state.invitation.used_at || state.invitation.revoked_at) return { rows: [] };
        state.invitation.used_at = values[1];
        return { rows: [{ invitation_hash: values[0] }] };
      }
      if (text.includes("INSERT INTO growthwise_connector_invitations")) {
        state.invitation = {
          invitation_hash: values[0], business_id: values[1], connectors: values[2], expires_at: values[3],
          revoked_at: null, used_at: null,
        };
        return { rows: [structuredClone(state.invitation)] };
      }
      if (text.includes("UPDATE growthwise_connector_invitations") && text.includes("revoked_at")) {
        if (state.invitation) state.invitation.revoked_at = values[1];
        return { rows: state.invitation ? [{ invitation_hash: values[0] }] : [] };
      }
      if (text.includes("FROM growthwise_connector_sessions")) {
        return { rows: state.session ? [structuredClone(state.session)] : [] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    release() { calls.push({ text: "RELEASE", values: [] }); },
  };
  return { calls, state, pool: { query: client.query.bind(client), async connect() { return client; } } };
}

test("invitation and session tokens contain 256 random bits and hash deterministically", () => {
  const invitations = new Set(Array.from({ length: 64 }, () => generateOpaqueToken("invitation")));
  const sessions = new Set(Array.from({ length: 64 }, () => generateOpaqueToken("session")));
  assert.equal(invitations.size, 64);
  assert.equal(sessions.size, 64);
  for (const value of invitations) assert.match(value, invitationTokenPattern);
  for (const value of sessions) assert.match(value, sessionTokenPattern);
  const token = [...invitations][0];
  assert.match(hashOpaqueToken(token), /^[a-f0-9]{64}$/);
  assert.equal(hashOpaqueToken(token), hashOpaqueToken(token));
});

test("creation persists only the invitation hash, exact tenant, connectors, and fixed expiry", async () => {
  const fixture = fakePool({ invitation: null });
  const store = createConnectorStore({ getPool: async () => fixture.pool });
  const raw = generateOpaqueToken("invitation");
  const invitationHash = hashOpaqueToken(raw);
  const row = await store.createInvitation({
    invitationHash, businessId: "dexters-hats", connectors: ["instagram", "facebook"], expiresAt: INVITE_EXPIRY,
  });
  assert.equal(row.invitation_hash, invitationHash);
  assert.equal(JSON.stringify(fixture.calls).includes(raw), false);
  assert.deepEqual(fixture.calls.find((call) => call.text.includes("INSERT INTO growthwise_connector_invitations")).values,
    [invitationHash, "dexters-hats", ["facebook", "instagram"], INVITE_EXPIRY]);
});

test("redemption atomically creates one fixed session and marks the invitation used", async () => {
  const fixture = fakePool();
  const store = createConnectorStore({ getPool: async () => fixture.pool });
  const sessionHash = "b".repeat(64);
  const result = await store.redeemInvitation({
    invitationHash: "a".repeat(64), sessionHash, now: NOW,
  });
  assert.deepEqual(result, {
    business_id: "dexters-hats", connectors: ["facebook", "instagram"], expires_at: SESSION_EXPIRY,
  });
  assert.equal(fixture.state.invitation.used_at.toISOString(), NOW.toISOString());
  assert.equal(fixture.state.session.session_hash, sessionHash);
  assert.equal(fixture.state.session.expires_at.toISOString(), SESSION_EXPIRY.toISOString());
  assert.deepEqual(fixture.calls.map((call) => call.text === "BEGIN" || call.text === "COMMIT" || call.text === "ROLLBACK" || call.text === "RELEASE" ? call.text : call.text.match(/(SELECT|INSERT|UPDATE)/)?.[1]),
    ["BEGIN", "SELECT", "INSERT", "UPDATE", "COMMIT", "RELEASE"]);
});

test("expired revoked used and missing invitations fail closed without creating sessions", async () => {
  const cases = [
    null,
    { expires_at: NOW, revoked_at: null, used_at: null },
    { expires_at: INVITE_EXPIRY, revoked_at: NOW, used_at: null },
    { expires_at: INVITE_EXPIRY, revoked_at: null, used_at: NOW },
  ];
  for (const change of cases) {
    const base = fakePool().state.invitation;
    const fixture = fakePool({ invitation: change === null ? null : { ...base, ...change } });
    const store = createConnectorStore({ getPool: async () => fixture.pool });
    await assert.rejects(store.redeemInvitation({ invitationHash: "a".repeat(64), sessionHash: "b".repeat(64), now: NOW }),
      /INVITATION_INVALID/);
    assert.equal(fixture.state.session, null);
  }
});

test("double and concurrent redemption produce exactly one logical winner", async () => {
  let locked = false;
  let releaseLock;
  const gate = new Promise((resolve) => { releaseLock = resolve; });
  const invitation = {
    invitation_hash: "a".repeat(64), business_id: "dexters-hats", connectors: ["instagram"],
    expires_at: INVITE_EXPIRY, revoked_at: null, used_at: null,
  };
  const sessions = [];
  function client() {
    return {
      async query(text, values = []) {
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("FOR UPDATE")) {
          if (locked) await gate;
          else locked = true;
          return { rows: [structuredClone(invitation)] };
        }
        if (text.includes("INSERT INTO growthwise_connector_sessions")) {
          sessions.push(values[0]); return { rows: [{}] };
        }
        if (text.includes("UPDATE growthwise_connector_invitations")) {
          if (invitation.used_at) return { rows: [] };
          invitation.used_at = values[1];
          releaseLock();
          return { rows: [{ invitation_hash: values[0] }] };
        }
        throw new Error("Unexpected SQL");
      },
      release() {},
    };
  }
  const pool = { async connect() { return client(); } };
  const store = createConnectorStore({ getPool: async () => pool });
  const outcomes = await Promise.allSettled([
    store.redeemInvitation({ invitationHash: "a".repeat(64), sessionHash: "b".repeat(64), now: NOW }),
    store.redeemInvitation({ invitationHash: "a".repeat(64), sessionHash: "c".repeat(64), now: NOW }),
  ]);
  assert.equal(outcomes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((result) => result.status === "rejected").length, 1);
  assert.equal(sessions.length, 1);
});

test("session authorization enforces hash tenant expiry revocation and connector without sliding", async () => {
  const fixture = fakePool();
  fixture.state.session = {
    session_hash: "b".repeat(64), business_id: "dexters-hats", connectors: ["instagram"],
    expires_at: SESSION_EXPIRY, revoked_at: null,
  };
  const store = createConnectorStore({ getPool: async () => fixture.pool });
  const ok = await store.authorizeSession({
    sessionHash: "b".repeat(64), businessId: "dexters-hats", connector: "instagram", now: NOW,
  });
  assert.deepEqual(ok, { business_id: "dexters-hats", connectors: ["instagram"], expires_at: SESSION_EXPIRY });
  assert.equal(fixture.calls.some((call) => call.text.includes("UPDATE growthwise_connector_sessions")), false);

  for (const input of [
    { businessId: "another-tenant", connector: "instagram", now: NOW },
    { businessId: "dexters-hats", connector: "facebook", now: NOW },
    { businessId: "dexters-hats", connector: "instagram", now: SESSION_EXPIRY },
  ]) {
    await assert.rejects(store.authorizeSession({ sessionHash: "b".repeat(64), ...input }), /SESSION_INVALID/);
  }
  fixture.state.session.revoked_at = NOW;
  await assert.rejects(store.authorizeSession({ sessionHash: "b".repeat(64), businessId: "dexters-hats", connector: "instagram", now: NOW }), /SESSION_INVALID/);
});

test("revocation is durable and the migration constrains hashes connectors and immutable identity", async () => {
  const fixture = fakePool();
  const store = createConnectorStore({ getPool: async () => fixture.pool });
  await store.revokeInvitation({ invitationHash: "a".repeat(64), now: NOW });
  await assert.rejects(store.redeemInvitation({ invitationHash: "a".repeat(64), sessionHash: "b".repeat(64), now: NOW }), /INVITATION_INVALID/);

  const migration = await readFile(new URL("../../netlify/database/migrations/20260923180000_connector-invitations/migration.sql", import.meta.url), "utf8");
  assert.match(migration, /CHECK \(invitation_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(migration, /CHECK \(session_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(migration, /facebook.*instagram|instagram.*facebook/s);
  assert.match(migration, /FOR EACH ROW EXECUTE FUNCTION prevent_connector_identity_change\(\)/);
});

test("direct tenant session creation stores only the session hash and returns safe metadata", async () => {
  const fixture = fakePool();
  const store = createConnectorStore({ getPool: async () => fixture.pool });
  const sessionHash = "d".repeat(64);
  const result = await store.createSession({
    sessionHash,
    businessId: "dexters-hats",
    connectors: ["instagram", "email"],
    expiresAt: SESSION_EXPIRY,
  });

  assert.deepEqual(result, {
    business_id: "dexters-hats",
    connectors: ["email", "instagram"],
    expires_at: SESSION_EXPIRY,
  });
  assert.equal(Object.hasOwn(result, "session_hash"), false);
  assert.equal(fixture.state.session.session_hash, sessionHash);
  assert.deepEqual(fixture.state.session.connectors, ["email", "instagram"]);
});
