import test from "node:test";
import assert from "node:assert/strict";
import { createInstagramConnectionHandler } from "../../netlify/functions/instagram-connection.mjs";
import { createInstagramCrypto } from "../../netlify/functions/_instagram-crypto.mjs";

const clients = {
  "growthwise-dev": { business_id: "growthwise-dev", integrations: { instagram: { token_env: "GW_TEST_META_TOKEN", account_id_env: "GW_TEST_IG_ACCOUNT_ID" } } },
  "dexters-hats": { business_id: "dexters-hats", integrations: { instagram: { token_env: "DEXTER_META_TOKEN", account_id_env: "DEXTER_IG_ACCOUNT_ID", review_publish_enabled: true } } },
};
const now = () => new Date("2026-09-17T01:02:03.000Z");
function request(businessId = "growthwise-dev", { key = "admin", method = "GET" } = {}) {
  return new Request(`https://example.test/.netlify/functions/instagram-connection?business_id=${businessId}`, { method, headers: { "x-growthwise-key": key } });
}
function base(overrides = {}) {
  return { adminKey: () => "admin", clients, readCredential: async () => null, env: () => undefined, now, ...overrides };
}
const row = {
  business_id: "growthwise-dev", account_binding_key: "binding-v1", status: "active",
  encrypted_credential: { algorithm: "A256GCM", ciphertext: "ciphertext-sentinel" },
  token_expires_at: "2026-10-17T01:02:03.000Z",
};
function stored(overrides = {}) {
  const updates = [];
  const options = base({
    readCredential: async () => ({ ...row, ...(overrides.row ?? {}) }),
    crypto: { accountBindingKeys: (id) => id === "ig-account-secret" ? ["binding-v1"] : ["other"] },
    decryptCredential: async () => ({ access_token: "synthetic-access-secret", account_id: "ig-account-secret", scope: "instagram_business_basic" }),
    verifyIdentity: async () => ({ accountId: "ig-account-secret", username: "growth.wise1", name: "GrowthWise" }),
    updateCredentialHealth: async (value) => { updates.push(value); },
    ...overrides,
  });
  delete options.row;
  return { options, updates };
}

 test("connection status requires authentication, known tenant, and GET", async () => {
  const handler = createInstagramConnectionHandler(base());
  assert.equal((await handler(request("growthwise-dev", { key: "bad" }))).status, 401);
  assert.equal((await handler(request("other"))).status, 404);
  assert.equal((await handler(request("growthwise-dev", { method: "POST" }))).status, 405);
});

test("missing OAuth credential emits only safe health stage", async () => {
  const logs = [];
  const body = await (await createInstagramConnectionHandler(base({
    logger: { warn: (...values) => logs.push(values) },
  }))(request())).json();
  assert.equal(body.state, "Not Connected");
  assert.deepEqual(logs, [["instagram_connection_health", { stage: "credential_not_found" }]]);
});

test("no OAuth credential and no approved fallback returns Not Connected", async () => {
  const body = await (await createInstagramConnectionHandler(base())(request())).json();
  assert.equal(body.state, "Not Connected");
  assert.deepEqual(Object.keys(body).sort(), ["action", "business_id", "checked_at", "state"]);
  assert.equal(JSON.stringify(body).includes("GW_TEST_META_TOKEN"), false);
});

test("valid stored OAuth credential and active binding returns Connected", async () => {
  const { options, updates } = stored();
  const body = await (await createInstagramConnectionHandler(options)(request())).json();
  assert.equal(body.state, "Connected");
  assert.deepEqual(body.account, { username: "growth.wise1", name: "GrowthWise" });
  assert.equal(updates[0].status, "active");
  assert.equal(updates[0].businessId, "growthwise-dev");
});

test("Dexter connection health requires publishing scope before reporting Connected", async () => {
  const { options: missingPublish } = stored({
    row: { business_id: "dexters-hats" },
    decryptCredential: async () => ({
      access_token: "synthetic-access-secret",
      account_id: "ig-account-secret",
      scope: "instagram_business_basic",
    }),
  });
  const missingBody = await (await createInstagramConnectionHandler(missingPublish)(request("dexters-hats"))).json();
  assert.equal(missingBody.state, "Needs Attention");

  const { options: ready } = stored({
    row: { business_id: "dexters-hats" },
    decryptCredential: async () => ({
      access_token: "synthetic-access-secret",
      account_id: "ig-account-secret",
      scope: "instagram_business_basic instagram_business_content_publish",
    }),
  });
  const readyBody = await (await createInstagramConnectionHandler(ready)(request("dexters-hats"))).json();
  assert.equal(readyBody.state, "Connected");
  assert.equal(readyBody.account.username, "growth.wise1");
});

test("stored credential decrypts from its authenticated binding before exact identity verification", async () => {
  const key = (byte) => Buffer.alloc(32, byte).toString("base64url");
  const crypto = createInstagramCrypto({
    stateSecrets: { current: { id: "s1", key: key(1) } },
    bindingSecrets: { current: { id: "b1", key: key(2) } },
    credentialKeys: { current: { id: "c1", key: key(3) } },
  });
  const accountId = "synthetic-professional-id";
  const encrypted = crypto.encryptCredential({
    businessId: "growthwise-dev", accountId,
    payload: { access_token: "synthetic-health-token", account_id: accountId, scope: "instagram_business_basic" },
  });
  const handler = createInstagramConnectionHandler(base({
    readCredential: async () => ({ ...row, account_binding_key: crypto.accountBindingKey(accountId), encrypted_credential: encrypted }),
    crypto,
    verifyIdentity: async ({ accessToken }) => {
      assert.equal(accessToken, "synthetic-health-token");
      return { accountId, username: "verified.user", name: "Verified" };
    },
    updateCredentialHealth: async () => {},
  }));
  const body = await (await handler(request())).json();
  assert.equal(body.state, "Connected");
  assert.deepEqual(body.account, { username: "verified.user", name: "Verified" });
});

test("Connected requires non-expired token and current exact identity match", async () => {
  for (const overrides of [
    { row: { token_expires_at: "2026-09-17T01:02:03.000Z" } },
    { verifyIdentity: async () => ({ accountId: "another", username: "wrong" }) },
  ]) {
    const { options } = stored(overrides);
    assert.equal((await (await createInstagramConnectionHandler(options)(request())).json()).state, "Needs Attention");
  }
});

test("missing malformed or near-expiry token metadata and missing identity scope fail closed", async () => {
  const cases = [
    { row: { token_expires_at: null } },
    { row: { token_expires_at: "not-a-date" } },
    { row: { token_expires_at: "2026-09-17T01:02:30.000Z" } },
    { decryptCredential: async () => ({ access_token: "synthetic-access-secret", account_id: "ig-account-secret" }) },
    { decryptCredential: async () => ({ access_token: "synthetic-access-secret", account_id: "ig-account-secret", scope: "instagram_business_content_publish" }) },
  ];
  for (const overrides of cases) {
    const { options } = stored(overrides);
    assert.equal((await (await createInstagramConnectionHandler(options)(request())).json()).state, "Needs Attention");
  }
});

test("expired or revoked credential returns Needs Attention", async () => {
  for (const rowChange of [{ token_expires_at: "2026-01-01T00:00:00Z" }, { status: "revoked" }]) {
    const { options } = stored({ row: rowChange });
    assert.equal((await (await createInstagramConnectionHandler(options)(request())).json()).state, "Needs Attention");
  }
});

test("provider invalid credential is marked needs_attention but a temporary failure is not persisted", async () => {
  for (const [code, expectedUpdates] of [["invalid_identity", 1], ["temporarily_unavailable", 0]]) {
    const error = Object.assign(new Error("provider detail"), { code });
    const { options, updates } = stored({ verifyIdentity: async () => { throw error; } });
    const body = await (await createInstagramConnectionHandler(options)(request())).json();
    assert.equal(body.state, "Needs Attention");
    assert.equal(body.action, code === "invalid_identity"
      ? "Reconnect Instagram so GrowthWise can verify this professional account."
      : "GrowthWise could not verify Meta right now. Try the connection check again.");
    assert.equal(updates.length, expectedUpdates);
    if (expectedUpdates) assert.equal(updates[0].status, "needs_attention");
    assert.equal(JSON.stringify(body).includes("provider detail"), false);
  }
});

test("oversized provider error bodies cannot turn retryable statuses into permanent credential failures", async () => {
  const oversized = "RAW_META_SENTINEL".repeat(4_000);
  for (const [status, expectedUpdates, expectedAction] of [
    [401, 1, "Reconnect Instagram so GrowthWise can verify this professional account."],
    [403, 1, "Reconnect Instagram so GrowthWise can verify this professional account."],
    [429, 0, "GrowthWise could not verify Meta right now. Try the connection check again."],
    [503, 0, "GrowthWise could not verify Meta right now. Try the connection check again."],
  ]) {
    const { options, updates } = stored({
      verifyIdentity: undefined,
      fetchImpl: async () => new Response(oversized, { status }),
    });
    const body = await (await createInstagramConnectionHandler(options)(request())).json();
    assert.equal(body.state, "Needs Attention");
    assert.equal(body.action, expectedAction);
    assert.equal(updates.length, expectedUpdates);
    assert.equal(JSON.stringify(body).includes("RAW_META_SENTINEL"), false);
  }
});

test("pending corrupt undecryptable or mismatched credential returns Needs Attention", async () => {
  const cases = [
    { row: { status: "pending" } },
    { decryptCredential: async () => { throw new Error("cipher details"); } },
    { crypto: { accountBindingKeys: () => ["wrong-binding"] } },
  ];
  for (const overrides of cases) {
    const { options } = stored(overrides);
    const body = await (await createInstagramConnectionHandler(options)(request())).json();
    assert.equal(body.state, "Needs Attention");
    assert.equal(JSON.stringify(body).includes("cipher"), false);
  }
});

test("stored bad credential never falls back to legacy token", async () => {
  let providerCalls = 0;
  const { options } = stored({
    row: { status: "revoked" }, env: (name) => ({ CONTEXT: "dev", GW_TEST_META_TOKEN: "legacy-secret", GW_TEST_IG_ACCOUNT_ID: "legacy-id" })[name],
    legacyFallbackEnabled: () => true, verifyIdentity: async () => { providerCalls++; return { accountId: "legacy-id", username: "legacy" }; },
  });
  const body = await (await createInstagramConnectionHandler(options)(request())).json();
  assert.equal(body.state, "Needs Attention");
  assert.equal(providerCalls, 0);
});

test("legacy development fallback remains available only when explicitly enabled", async () => {
  const env = (name) => ({ CONTEXT: "dev", GW_TEST_META_TOKEN: "legacy-secret", GW_TEST_IG_ACCOUNT_ID: "legacy-id" })[name];
  const verifyIdentity = async () => ({ accountId: "legacy-id", username: "legacy.user", name: "Legacy" });
  for (const [context, enabled, expected] of [["dev", true, "Connected"], ["dev", false, "Not Connected"], ["production", true, "Not Connected"]]) {
    const handler = createInstagramConnectionHandler(base({ env: (name) => name === "CONTEXT" ? context : env(name), legacyFallbackEnabled: () => enabled, verifyIdentity }));
    assert.equal((await (await handler(request())).json()).state, expected);
  }
});

test("cross-tenant credential or account binding fails closed", async () => {
  for (const overrides of [{ row: { business_id: "dexters-hats" } }, { crypto: { accountBindingKeys: () => ["foreign-binding"] } }]) {
    const { options } = stored(overrides);
    assert.equal((await (await createInstagramConnectionHandler(options)(request())).json()).state, "Needs Attention");
  }
});

test("connection response never contains account ID token ciphertext expiry or raw Meta error", async () => {
  const { options } = stored({ verifyIdentity: async () => { throw new Error("raw Meta sentinel"); } });
  const text = await (await createInstagramConnectionHandler(options)(request())).text();
  for (const forbidden of ["ig-account-secret", "synthetic-access-secret", "ciphertext-sentinel", "2026-10-17", "raw Meta sentinel"]) {
    assert.equal(text.includes(forbidden), false);
  }
});

test("wrong or ambiguous account context fails closed", async () => {
  for (const identity of [{ accountId: "different", username: "wrong" }, [{ accountId: "ig-account-secret", username: "one" }]]) {
    const { options } = stored({ verifyIdentity: async () => identity });
    const body = await (await createInstagramConnectionHandler(options)(request())).json();
    assert.equal(body.state, "Needs Attention");
    assert.equal(body.account, undefined);
  }
});
