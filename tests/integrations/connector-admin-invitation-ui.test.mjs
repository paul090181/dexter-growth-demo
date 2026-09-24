import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  createGrowthWiseDevEmailInvitationController,
} from "../../assets/admin-connector-invitation.mjs";

const ORIGIN = "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app";
const INVITE = `${ORIGIN}/connect-accounts.html#invite=gw_inv_${"A".repeat(43)}`;

function storageWith(value = "saved-admin-key") {
  const values = new Map(value ? [["growthwise_admin_key", value]] : []);
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, next) { values.set(key, String(next)); },
    removeItem(key) { values.delete(key); },
  };
}

test("admin invitation control creates only growthwise-dev email invitation and opens it", async () => {
  const calls = [];
  const navigated = [];
  const states = [];
  const storage = storageWith();

  const controller = createGrowthWiseDevEmailInvitationController({
    origin: ORIGIN,
    storage,
    onState: (state) => states.push(state),
    navigate: (url) => navigated.push(url),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        business_id: "growthwise-dev",
        connectors: ["email"],
        expires_at: "2026-09-24T20:00:00.000Z",
        invitation_url: INVITE,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(controller.hasAdminKey(), true);
  assert.equal(await controller.createAndOpen(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/connector-invitation-create");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-GrowthWise-Key"], "saved-admin-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    business_id: "growthwise-dev",
    connectors: ["email"],
  });
  assert.deepEqual(navigated, [INVITE]);
  assert.equal(states.some((state) => JSON.stringify(state).includes("gw_inv_")), false);
});

test("admin invitation control refuses mismatched tenant or connector response", async () => {
  for (const body of [
    { business_id: "dexters-hats", connectors: ["email"], invitation_url: INVITE },
    { business_id: "growthwise-dev", connectors: ["email", "instagram"], invitation_url: INVITE },
  ]) {
    let navigated = false;
    const controller = createGrowthWiseDevEmailInvitationController({
      origin: ORIGIN,
      storage: storageWith(),
      navigate: () => { navigated = true; },
      fetchImpl: async () => new Response(JSON.stringify(body), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    assert.equal(await controller.createAndOpen(), false);
    assert.equal(navigated, false);
  }
});

test("admin invitation control rejects cross-origin or malformed invitation URL", async () => {
  for (const invitation_url of [
    `https://evil.example/connect-accounts.html#invite=gw_inv_${"A".repeat(43)}`,
    `${ORIGIN}/connect-accounts.html?leak=1#invite=gw_inv_${"A".repeat(43)}`,
    `${ORIGIN}/connect-accounts.html#invite=not-a-token`,
  ]) {
    let navigated = false;
    const controller = createGrowthWiseDevEmailInvitationController({
      origin: ORIGIN,
      storage: storageWith(),
      navigate: () => { navigated = true; },
      fetchImpl: async () => new Response(JSON.stringify({
        business_id: "growthwise-dev",
        connectors: ["email"],
        invitation_url,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    assert.equal(await controller.createAndOpen(), false);
    assert.equal(navigated, false);
  }
});

test("401 removes stale admin key and never navigates", async () => {
  const storage = storageWith();
  let navigated = false;
  const controller = createGrowthWiseDevEmailInvitationController({
    origin: ORIGIN,
    storage,
    navigate: () => { navigated = true; },
    fetchImpl: async () => new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(await controller.createAndOpen(), false);
  assert.equal(storage.getItem("growthwise_admin_key"), null);
  assert.equal(navigated, false);
});

test("operator UI is admin-gated and fixed to growthwise-dev email only", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="emailAcceptanceOperator"[^>]*class="operator-card hidden"|class="operator-card hidden" id="emailAcceptanceOperator"/);
  assert.match(html, /growthwise-dev · email only/);
  assert.match(html, /cannot target Dexter’s Hats/);
  assert.match(html, /assets\/admin-connector-invitation\.mjs/);
  assert.doesNotMatch(html, /id="emailAcceptanceInvitationUrl"/);
});
