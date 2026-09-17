import test from "node:test";
import assert from "node:assert/strict";
import { createInstagramConnectionHandler } from "../../netlify/functions/instagram-connection.mjs";

const clients = {
  "growthwise-dev": { business_id: "growthwise-dev", integrations: { instagram: { token_env: "GW_TEST_META_TOKEN", account_id_env: "GW_TEST_IG_ACCOUNT_ID" } } },
  "dexters-hats": { business_id: "dexters-hats", integrations: { instagram: { token_env: "DEXTER_META_TOKEN", account_id_env: "DEXTER_IG_ACCOUNT_ID" } } },
};

function request(businessId = "growthwise-dev", { key = "admin", method = "GET" } = {}) {
  return new Request(`https://example.test/.netlify/functions/instagram-connection?business_id=${businessId}`, {
    method,
    headers: { "x-growthwise-key": key },
  });
}

test("connection status requires authentication, known tenant, and GET", async () => {
  const handler = createInstagramConnectionHandler({ adminKey: () => "admin", clients, env: () => undefined });
  assert.equal((await handler(request("growthwise-dev", { key: "bad" }))).status, 401);
  assert.equal((await handler(request("other"))).status, 404);
  assert.equal((await handler(request("growthwise-dev", { method: "POST" }))).status, 405);
});

test("returns Not Connected without exposing the credential reference", async () => {
  const handler = createInstagramConnectionHandler({ adminKey: () => "admin", clients, env: () => undefined });
  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "Not Connected");
  assert.equal(body.business_id, "growthwise-dev");
  assert.equal(JSON.stringify(body).includes("GW_TEST_META_TOKEN"), false);
  assert.equal(JSON.stringify(body).includes("token"), false);
});

test("verifies an account-scoped Instagram Login professional token and returns a redacted Connected status", async () => {
  const calls = [];
  const handler = createInstagramConnectionHandler({
    adminKey: () => "admin",
    clients,
    env: (name) => ({ GW_TEST_META_TOKEN: "test-meta-credential", GW_TEST_IG_ACCOUNT_ID: "ig-account-secret" })[name],
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ user_id: "ig-account-secret", username: "growth.wise1", name: "GrowthWise" }), { status: 200 });
    },
    now: () => new Date("2026-09-17T01:02:03.000Z"),
  });
  const response = await handler(request());
  const body = await response.json();
  assert.equal(body.state, "Connected");
  assert.equal(body.account.username, "growth.wise1");
  assert.equal(body.checked_at, "2026-09-17T01:02:03.000Z");
  assert.deepEqual(Object.keys(body.account).sort(), ["name", "username"]);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-meta-credential");
  assert.match(calls[0].url, /^https:\/\/graph\.instagram\.com\/v\d+\.\d+\/me\?/);
  assert.equal(calls[0].url.includes("/me/accounts"), false);
  assert.equal(calls[0].url.includes("test-meta-credential"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("returns Needs Attention with a safe message for a rejected or expired token", async () => {
  const handler = createInstagramConnectionHandler({
    adminKey: () => "admin",
    clients,
    env: (name) => name.endsWith("TOKEN") ? "rejected-token-secret" : "ig-account-secret",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "raw sensitive graph detail", code: 190 } }), { status: 401 }),
  });
  const body = await (await handler(request())).json();
  assert.equal(body.state, "Needs Attention");
  assert.equal(JSON.stringify(body).includes("raw sensitive"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("wrong or ambiguous account context fails closed", async () => {
  for (const graphResponse of [
    new Response(JSON.stringify({ user_id: "different-account-secret", username: "wrong.account" }), { status: 200 }),
    new Response(JSON.stringify({ data: [
      { user_id: "ig-account-secret", username: "first.account" },
      { user_id: "other-account-secret", username: "second.account" },
    ] }), { status: 200 }),
  ]) {
    const handler = createInstagramConnectionHandler({
      adminKey: () => "admin",
      clients,
      env: (name) => name.endsWith("TOKEN") ? "token-secret" : "ig-account-secret",
      fetchImpl: async () => graphResponse,
    });
    const body = await (await handler(request())).json();
    assert.equal(body.state, "Needs Attention");
    assert.equal(JSON.stringify(body).includes("secret"), false);
    assert.equal(body.account, undefined);
  }
});
