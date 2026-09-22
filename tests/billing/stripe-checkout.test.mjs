import assert from "node:assert/strict";
import test from "node:test";

import { createStripeCheckoutHandler } from "../../netlify/functions/stripe-checkout.mjs";

const URL = "https://preview.example/.netlify/functions/stripe-checkout";

function request(body = {}, options = {}) {
  return new Request(URL, {
    method: options.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-key": options.key || "valid-key",
    },
    body: options.method === "GET" ? undefined : JSON.stringify(body),
  });
}

function fixture(overrides = {}) {
  const createCalls = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (input) => {
          createCalls.push(input);
          return { url: "https://checkout.stripe.com/c/pay/cs_test_123" };
        },
      },
    },
  };
  const handler = createStripeCheckoutHandler({
    authorized: (req) => ({ ok: req.headers.get("x-growthwise-key") === "valid-key" }),
    stripe,
    priceId: "price_server",
    origin: "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app",
    tenants: new Set(["growthwise-dev", "dexters-hats"]),
    ...overrides,
  });
  return { handler, createCalls, stripe };
}

test("Checkout ignores client pricing and uses server configuration", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "growthwise-dev", price: "price_attacker", amount: 1 }));

  assert.equal(response.status, 200);
  assert.equal(createCalls[0].line_items[0].price, "price_server");
  assert.equal(createCalls[0].mode, "subscription");
  assert.deepEqual(createCalls[0].metadata, { business_id: "growthwise-dev", plan_key: "founding_monthly" });
  assert.deepEqual(createCalls[0].subscription_data.metadata, { business_id: "growthwise-dev", plan_key: "founding_monthly" });
});

test("Checkout rejects a valid key for an unknown tenant", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "attacker-tenant" }));

  assert.equal(response.status, 404);
  assert.equal(createCalls.length, 0);
});

test("Checkout derives return URLs from the configured preview origin", async () => {
  const { handler, createCalls } = fixture();
  await handler(request({ business_id: "growthwise-dev", success_url: "https://evil.example" }));

  assert.match(createCalls[0].success_url, /^https:\/\/deploy-preview-14--/);
  assert.doesNotMatch(createCalls[0].success_url, /evil/);
  assert.equal(createCalls[0].cancel_url, "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app/?billing=cancelled");
});

test("Checkout requires authentication before calling Stripe", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "growthwise-dev" }, { key: "wrong" }));

  assert.equal(response.status, 401);
  assert.equal(createCalls.length, 0);
});

test("Checkout allows only POST", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({}, { method: "GET" }));

  assert.equal(response.status, 405);
  assert.equal(createCalls.length, 0);
});

test("Checkout rejects oversized request bodies", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "growthwise-dev", padding: "x".repeat(20_000) }));

  assert.equal(response.status, 413);
  assert.equal(createCalls.length, 0);
});

test("Checkout fails closed when required configuration is invalid", async () => {
  const missingPrice = fixture({ priceId: "" });
  assert.equal((await missingPrice.handler(request({ business_id: "growthwise-dev" }))).status, 503);

  const insecureOrigin = fixture({ origin: "http://preview.example" });
  assert.equal((await insecureOrigin.handler(request({ business_id: "growthwise-dev" }))).status, 503);
});

test("Checkout returns only Stripe-hosted HTTPS checkout URLs", async () => {
  const stripe = { checkout: { sessions: { create: async () => ({ url: "https://evil.example/session" }) } } };
  const { handler } = fixture({ stripe });
  const response = await handler(request({ business_id: "growthwise-dev" }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Checkout session unavailable." });
});

test("Checkout returns the approved URL without leaking the session object", async () => {
  const { handler } = fixture();
  const response = await handler(request({ business_id: "dexters-hats" }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { checkout_url: "https://checkout.stripe.com/c/pay/cs_test_123" });
});
