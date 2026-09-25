import assert from "node:assert/strict";
import test from "node:test";

import { createStripeCheckoutHandler } from "../../netlify/functions/stripe-checkout.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";

const URL = "https://preview.example/.netlify/functions/stripe-checkout";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

function request(body = {}, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.key !== "") headers["x-growthwise-key"] = options.key || "valid-key";
  if (options.tenantKey) headers["x-growthwise-tenant-key"] = options.tenantKey;
  return new Request(URL, {
    method: options.method || "POST",
    headers,
    body: options.method === "GET" ? undefined : JSON.stringify(body),
  });
}

function fixture(overrides = {}) {
  const createCalls = [];
  const createOptions = [];
  const stripe = {
    checkout: {
      sessions: {
        create: async (input, options) => {
          createCalls.push(input);
          createOptions.push(options);
          return { url: "https://checkout.stripe.com/c/pay/cs_test_123" };
        },
      },
    },
  };
  const handler = createStripeCheckoutHandler({
    authorized: (req) => ({ ok: req.headers.get("x-growthwise-key") === "valid-key" }),
    stripe,
    priceIds: {
      founding_monthly: "price_founding",
      starter_monthly: "price_starter",
      growth_monthly: "price_growth",
      pro_monthly: "price_pro",
    },
    origin: "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app",
    tenants: new Set(["growthwise-dev", "dexters-hats"]),
    tenantStore: {
      readTenantAuth: async ({ businessId }) => businessId === "tenant-self-abcdef123456"
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null,
    },
    billingStore: { readSubscription: async () => null },
    ...overrides,
  });
  return { handler, createCalls, createOptions, stripe };
}

test("Checkout ignores client pricing and uses server configuration", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "growthwise-dev", price: "price_attacker", amount: 1 }));

  assert.equal(response.status, 200);
  assert.equal(createCalls[0].line_items[0].price, "price_growth");
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
  const missingPrice = fixture({ priceIds: { founding_monthly: "" } });
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

test("tenant checkout requires its exact business ID and uses only server-mapped plan pricing", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({
    business_id: "tenant-self-abcdef123456",
    plan_key: "growth_monthly",
    price: "price_attacker",
  }, { key: "", tenantKey: TENANT_KEY }));

  assert.equal(response.status, 200);
  assert.deepEqual(createCalls[0].metadata, {
    business_id: "tenant-self-abcdef123456",
    plan_key: "growth_monthly",
  });
  assert.equal(createCalls[0].line_items[0].price, "price_founding");
  assert.equal(createCalls[0].success_url,
    "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app/signup.html?billing=success&session_id={CHECKOUT_SESSION_ID}");
  assert.equal(createCalls[0].cancel_url,
    "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app/signup.html?billing=cancelled");
});

test("one tenant key cannot create checkout for another business", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "tenant-other-abcdef123456" }, {
    key: "",
    tenantKey: TENANT_KEY,
  }));

  assert.equal(response.status, 401);
  assert.equal(createCalls.length, 0);
});

test("checkout is blocked once a Stripe subscription is already bound", async () => {
  const { handler, createCalls } = fixture({
    billingStore: {
      readSubscription: async () => ({
        business_id: "tenant-self-abcdef123456",
        access_source: "stripe",
        status: "active",
        stripe_subscription_id: "sub_existing",
      }),
    },
  });
  const response = await handler(request({ business_id: "tenant-self-abcdef123456" }, {
    key: "",
    tenantKey: TENANT_KEY,
  }));

  assert.equal(response.status, 409);
  assert.equal(createCalls.length, 0);
});

test("concurrent checkout requests share one Stripe idempotency key", async () => {
  const { handler, createCalls, createOptions } = fixture();
  const makeRequest = () => request({ business_id: "tenant-self-abcdef123456" }, {
    key: "",
    tenantKey: TENANT_KEY,
  });

  const responses = await Promise.all([handler(makeRequest()), handler(makeRequest())]);

  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.equal(createCalls.length, 2);
  assert.equal(createOptions[0].idempotencyKey, createOptions[1].idempotencyKey);
  assert.match(createOptions[0].idempotencyKey, /^growthwise-checkout-[a-f0-9]{32}$/);
});


test("checkout rejects unknown plan keys instead of trusting client pricing", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({
    business_id: "growthwise-dev",
    plan_key: "enterprise_1_dollar",
    price: "price_attacker",
    amount: 1,
  }));
  assert.equal(response.status, 400);
  assert.equal(createCalls.length, 0);
});

test("checkout rejects a known plan when its server Stripe price is not configured", async () => {
  const { handler, createCalls } = fixture({
    priceIds: {
      founding_monthly: "price_founding",
      starter_monthly: "price_starter",
      growth_monthly: "",
      pro_monthly: "price_pro",
    },
  });
  const response = await handler(request({
    business_id: "growthwise-dev",
    plan_key: "growth_monthly",
  }));
  assert.equal(response.status, 503);
  assert.equal(createCalls.length, 0);
});
