import assert from "node:assert/strict";
import test from "node:test";

import { hashOpaqueToken, invitationTokenPattern, sessionTokenPattern } from "../../netlify/functions/_connector-auth.mjs";
import { createConnectorInvitationCreateHandler } from "../../netlify/functions/connector-invitation-create.mjs";
import { createConnectorInvitationExchangeHandler } from "../../netlify/functions/connector-invitation-exchange.mjs";
import { createConnectorSessionHandler } from "../../netlify/functions/connector-session.mjs";
import { createConnectorTenantResolver } from "../../netlify/functions/_connector-tenants.mjs";

const ORIGIN = "https://deploy-preview-14--growthwise.example";
const NOW = new Date("2026-09-23T12:00:00.000Z");

function createRequest(body, { key = "admin", method = "POST", path = "connector-invitation-create", origin = ORIGIN } = {}) {
  return new Request(`${ORIGIN}/.netlify/functions/${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin,
      ...(key ? { "x-growthwise-key": key } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

function memoryStore() {
  const invitations = new Map();
  const sessions = new Map();
  return {
    invitations,
    sessions,
    async createInvitation(input) {
      invitations.set(input.invitationHash, structuredClone(input));
      return input;
    },
    async redeemInvitation({ invitationHash, sessionHash, now }) {
      const invitation = invitations.get(invitationHash);
      if (!invitation || invitation.used || invitation.revoked || invitation.expiresAt <= now) throw new Error("INVITATION_INVALID");
      invitation.used = true;
      const row = {
        business_id: invitation.businessId,
        connectors: [...invitation.connectors].sort(),
        expires_at: new Date(now.getTime() + 30 * 60 * 1000),
      };
      sessions.set(sessionHash, row);
      return structuredClone(row);
    },
    async authorizeSession({ sessionHash, businessId, connector, now }) {
      const row = sessions.get(sessionHash);
      if (!row || row.expires_at <= now || (businessId && row.business_id !== businessId)
        || (connector && !row.connectors.includes(connector))) throw new Error("SESSION_INVALID");
      return structuredClone(row);
    },
  };
}

function createFixture() {
  const store = memoryStore();
  const resolveTenant = createConnectorTenantResolver({
    pilotTenants: { "dexters-hats": { business_id: "dexters-hats", display_name: "Dexter's Hats" } },
    tenantStore: { async readTenantProfile({ businessId }) {
      return businessId === "paid-shop-abcdef123456"
        ? { business_id: businessId, business_name: "Paid Shop" } : null;
    } },
  });
  const create = createConnectorInvitationCreateHandler({
    authorized: (request) => ({ ok: request.headers.get("x-growthwise-key") === "admin" }),
    store, resolveTenant, publicOrigin: () => ORIGIN, now: () => NOW,
  });
  const exchange = createConnectorInvitationExchangeHandler({
    store, publicOrigin: () => ORIGIN, now: () => NOW,
  });
  const session = createConnectorSessionHandler({ store, now: () => NOW, resolveTenant });
  return { store, create, exchange, session };
}

test("invitation creation is admin-only and accepts pilot tenants without billing checks", async () => {
  const fixture = createFixture();
  const unauthorized = await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram"] }, { key: "bad" }));
  assert.equal(unauthorized.status, 401);
  assert.equal(fixture.store.invitations.size, 0);

  const response = await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram", "facebook", "email"] }));
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.expires_at, "2026-09-24T12:00:00.000Z");
  assert.equal(body.business_id, "dexters-hats");
  assert.equal(body.connectors.join(","), "email,facebook,instagram");
});

test("database-backed tenants use the same invitation path without Stripe status", async () => {
  const fixture = createFixture();
  const response = await fixture.create(createRequest({ business_id: "paid-shop-abcdef123456", connectors: ["instagram"] }));
  assert.equal(response.status, 201);
  assert.equal((await response.json()).business_id, "paid-shop-abcdef123456");
});

test("creation rejects unknown tenants malformed bodies and unsupported connectors", async () => {
  const fixture = createFixture();
  for (const body of [
    { business_id: "unknown", connectors: ["instagram"] },
    { business_id: "dexters-hats", connectors: [] },
    { business_id: "dexters-hats", connectors: ["instagram", "tiktok"] },
    { business_id: "dexters-hats", connectors: ["instagram"], admin_key: "admin" },
  ]) assert.equal((await fixture.create(createRequest(body))).status, 400);
  assert.equal(fixture.store.invitations.size, 0);
});

test("returned invitation is fragment-only and contains no admin or tenant credential", async () => {
  const fixture = createFixture();
  const response = await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram"] }));
  const body = await response.json();
  const url = new URL(body.invitation_url);
  assert.equal(url.origin, ORIGIN);
  assert.equal(url.pathname, "/connect-accounts.html");
  assert.equal(url.search, "");
  assert.match(url.hash, /^#invite=gw_inv_[A-Za-z0-9_-]{43}$/);
  const raw = url.hash.slice("#invite=".length);
  assert.match(raw, invitationTokenPattern);
  assert.equal(body.invitation_url.includes("admin"), false);
  assert.equal(body.invitation_url.includes("gw_tenant_"), false);
  assert.equal(JSON.stringify([...fixture.store.invitations.values()]).includes(raw), false);
  assert.ok(fixture.store.invitations.has(hashOpaqueToken(raw)));
});

test("exchange sets only a secure fixed-lifetime HttpOnly session cookie", async () => {
  const fixture = createFixture();
  const created = await (await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram", "facebook", "email"] }))).json();
  const token = new URL(created.invitation_url).hash.slice("#invite=".length);
  const response = await fixture.exchange(createRequest({ invitation_token: token }, { key: "", path: "connector-invitation-exchange" }));
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /^__Host-gw_connector_session=gw_conn_[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /Max-Age=1800/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes("Domain="), false);
  assert.equal(JSON.stringify([...fixture.store.sessions.values()]).match(sessionTokenPattern), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

test("exchange rejects malformed invalid and replayed invitations without a cookie", async () => {
  const fixture = createFixture();
  const invalid = await fixture.exchange(createRequest({ invitation_token: "bad" }, { key: "", path: "connector-invitation-exchange" }));
  assert.equal(invalid.status, 401);
  assert.equal(invalid.headers.has("set-cookie"), false);

  const created = await (await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram"] }))).json();
  const token = new URL(created.invitation_url).hash.slice("#invite=".length);
  assert.equal((await fixture.exchange(createRequest({ invitation_token: token }, { key: "", path: "connector-invitation-exchange" }))).status, 200);
  const replay = await fixture.exchange(createRequest({ invitation_token: token }, { key: "", path: "connector-invitation-exchange" }));
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.has("set-cookie"), false);
});

test("session metadata comes only from the cookie-bound tenant and keeps Facebook unavailable", async () => {
  const fixture = createFixture();
  const created = await (await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram", "facebook"] }))).json();
  const token = new URL(created.invitation_url).hash.slice("#invite=".length);
  const exchange = await fixture.exchange(createRequest({ invitation_token: token }, { key: "", path: "connector-invitation-exchange" }));
  const cookie = exchange.headers.get("set-cookie").split(";", 1)[0];
  const response = await fixture.session(new Request(`${ORIGIN}/.netlify/functions/connector-session?business_id=another-tenant`, {
    headers: { cookie },
  }));
  assert.equal(response.status, 400);

  const good = await fixture.session(new Request(`${ORIGIN}/.netlify/functions/connector-session`, { headers: { cookie } }));
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), {
    business_id: "dexters-hats",
    business_name: "Dexter's Hats",
    expires_at: "2026-09-23T12:30:00.000Z",
    connectors: {
      facebook: { allowed: true, available: false, state: "Setup unavailable" },
      instagram: { allowed: true, available: true },
      email: { allowed: true, available: false, state: "Setup unavailable" },
    },
  });
});

test("all invitation responses are non-cacheable and use a restrictive referrer policy", async () => {
  const fixture = createFixture();
  const responses = [
    await fixture.create(createRequest({ business_id: "dexters-hats", connectors: ["instagram"] })),
    await fixture.exchange(createRequest({ invitation_token: "bad" }, { key: "", path: "connector-invitation-exchange" })),
    await fixture.session(new Request(`${ORIGIN}/.netlify/functions/connector-session`)),
  ];
  for (const response of responses) {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});
