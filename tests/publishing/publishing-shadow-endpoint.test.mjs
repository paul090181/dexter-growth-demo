import test from "node:test";
import assert from "node:assert/strict";
import { createPublishingShadowHandler } from "../../netlify/functions/publishing-shadow.mjs";
import { automotiveVehicle, automotiveMedia } from "./fixtures/automotive-vehicle.mjs";
import { retailProduct, retailMedia } from "./fixtures/retail-product.mjs";

const handler = createPublishingShadowHandler({
  adminKey: () => "test-secret",
  saveRun: async () => {},
});

function request(body, { method = "POST", key = "test-secret" } = {}) {
  return new Request("https://example.test/.netlify/functions/publishing-shadow", {
    method,
    headers: { "content-type": "application/json", "x-growthwise-key": key },
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
  });
}

test("endpoint rejects invalid credentials and methods", async () => {
  assert.equal((await handler(request({}, { key: "wrong" }))).status, 401);
  assert.equal((await handler(request({}, { method: "GET" }))).status, 405);
});

test("endpoint rejects unknown businesses and verticals", async () => {
  assert.equal((await handler(request({ business_id: "unknown", vertical: "automotive" }))).status, 400);
  assert.equal((await handler(request({ business_id: "auto-city", vertical: "retail" }))).status, 400);
});

for (const example of [
  { business_id: "auto-city", vertical: "automotive", source_record: automotiveVehicle, media: automotiveMedia },
  { business_id: "dexters-hats", vertical: "retail", source_record: retailProduct, media: retailMedia },
]) {
  test(`returns a safe shadow response for ${example.business_id}`, async () => {
    const response = await handler(request({ ...example, role: "owner_admin", channels: ["facebook-marketplace"] }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, "shadow");
    assert.equal(body.live_actions_enabled, false);
    assert.equal(body.business_id, example.business_id);
    assert.equal(body.results[0].live_sent, false);
  });
}
