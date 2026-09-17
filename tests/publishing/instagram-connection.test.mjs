import test from "node:test";
import assert from "node:assert/strict";
import { createInstagramConnectionHandler } from "../../netlify/functions/instagram-connection.mjs";

const clients = {
  "growthwise-dev": { business_id: "growthwise-dev", integrations: { instagram: { token_env: "GW_TEST_META_TOKEN" } } },
  "dexters-hats": { business_id: "dexters-hats", integrations: { instagram: { token_env: "DEXTER_META_TOKEN" } } },
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

test("discovers a professional account and returns a redacted Connected status", async () => {
  const calls = [];
  const handler = createInstagramConnectionHandler({
    adminKey: () => "admin",
    clients,
    env: (name) => name === "GW_TEST_META_TOKEN" ? "test-meta-credential" : undefined,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ data: [{ id: "page-secret", instagram_business_account: { id: "ig-secret", username: "growth.wise1", name: "GrowthWise" } }] }), { status: 200 });
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
  assert.equal(calls[0].url.includes("test-meta-credential"), false);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("returns Needs Attention with a safe message for rejected or ineligible connections", async () => {
  for (const graphResponse of [
    new Response(JSON.stringify({ error: { message: "raw sensitive graph detail", code: 190 } }), { status: 401 }),
    new Response(JSON.stringify({ data: [{ id: "page-without-instagram" }] }), { status: 200 }),
  ]) {
    const handler = createInstagramConnectionHandler({
      adminKey: () => "admin", clients, env: () => "secret", fetchImpl: async () => graphResponse,
    });
    const body = await (await handler(request())).json();
    assert.equal(body.state, "Needs Attention");
    assert.equal(JSON.stringify(body).includes("raw sensitive"), false);
    assert.equal(JSON.stringify(body).includes("secret"), false);
  }
});
