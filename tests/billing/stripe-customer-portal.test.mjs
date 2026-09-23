import assert from "node:assert/strict";
import test from "node:test";

import { createStripeCustomerPortalHandler } from "../../netlify/functions/stripe-customer-portal.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";

const URL = "https://preview.example/.netlify/functions/stripe-customer-portal";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;
const BUSINESS_ID = "tenant-self-abcdef123456";

function request(body = {}, options = {}) {
  const headers = { "content-type": "application/json" };
  if (options.tenantKey !== "") headers["x-growthwise-tenant-key"] = options.tenantKey || TENANT_KEY;
  return new Request(URL, {
    method: options.method || "POST",
    headers,
    body: options.method === "GET" ? undefined : JSON.stringify(body),
  });
}

function fixture(overrides = {}) {
  const createCalls = [];
  const stripe = {
    billingPortal: {
      sessions: {
        create: async (input) => {
          createCalls.push(input);
          return { url: "https://billing.stripe.com/p/session/test_123" };
        },
      },
    },
  };
  const subscription = {
    business_id: BUSINESS_ID,
    access_source: "stripe",
    plan_key: "founding_monthly",
    status: "active",
    stripe_customer_id: "cus_server",
    stripe_subscription_id: "sub_server",
  };
  const handler = createStripeCustomerPortalHandler({
    stripe,
    origin: "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app",
    tenantStore: {
      readTenantAuth: async ({ businessId }) => businessId === BUSINESS_ID
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null,
    },
    billingStore: { readSubscription: async () => subscription },
    ...overrides,
  });
  return { handler, stripe, createCalls, subscription };
}

test("customer portal requires POST", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({}, { method: "GET" }));

  assert.equal(response.status, 405);
  assert.equal(createCalls.length, 0);
});

test("customer portal requires a business ID", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({}));

  assert.equal(response.status, 400);
  assert.equal(createCalls.length, 0);
});

test("customer portal requires the exact tenant key before calling Stripe", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: BUSINESS_ID }, { tenantKey: "wrong" }));

  assert.equal(response.status, 401);
  assert.equal(createCalls.length, 0);
});

test("one tenant key cannot open billing for another business", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({ business_id: "tenant-other-abcdef123456" }));

  assert.equal(response.status, 401);
  assert.equal(createCalls.length, 0);
});

test("customer portal uses only the server-stored Stripe customer binding", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({
    business_id: BUSINESS_ID,
    customer: "cus_attacker",
    return_url: "https://evil.example",
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(createCalls, [{
    customer: "cus_server",
    return_url: "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app/signup.html?billing=manage-return",
  }]);
  assert.deepEqual(await response.json(), {
    portal_url: "https://billing.stripe.com/p/session/test_123",
  });
});

test("customer portal never returns Stripe customer or subscription IDs", async () => {
  const { handler } = fixture();
  const response = await handler(request({ business_id: BUSINESS_ID }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body), ["portal_url"]);
  assert.doesNotMatch(JSON.stringify(body), /cus_server|sub_server/);
});

test("pilot access cannot open a Stripe billing portal", async () => {
  const { handler, createCalls, subscription } = fixture({
    billingStore: { readSubscription: async () => ({ ...subscription, access_source: "pilot" }) },
  });
  const response = await handler(request({ business_id: BUSINESS_ID }));

  assert.equal(response.status, 409);
  assert.equal(createCalls.length, 0);
});

test("a tenant without a linked Stripe customer cannot open the portal", async () => {
  const { handler, createCalls } = fixture({
    billingStore: { readSubscription: async () => null },
  });
  const response = await handler(request({ business_id: BUSINESS_ID }));

  assert.equal(response.status, 409);
  assert.equal(createCalls.length, 0);
});

test("paid tenants can manage billing even when payment needs attention or is canceled", async () => {
  for (const status of ["past_due", "unpaid", "canceled"]) {
    const base = fixture();
    const handler = createStripeCustomerPortalHandler({
      stripe: base.stripe,
      origin: "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app",
      tenantStore: {
        readTenantAuth: async ({ businessId }) => businessId === BUSINESS_ID
          ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
          : null,
      },
      billingStore: {
        readSubscription: async () => ({ ...base.subscription, status }),
      },
    });
    const response = await handler(request({ business_id: BUSINESS_ID }));
    assert.equal(response.status, 200);
  }
});

test("customer portal rejects non-Stripe redirect destinations", async () => {
  const stripe = {
    billingPortal: { sessions: { create: async () => ({ url: "https://evil.example/session" }) } },
  };
  const { handler } = fixture({ stripe });
  const response = await handler(request({ business_id: BUSINESS_ID }));

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Billing management session unavailable." });
});

test("customer portal fails closed when configuration is invalid", async () => {
  const missingStripe = fixture({ stripe: {} });
  assert.equal((await missingStripe.handler(request({ business_id: BUSINESS_ID }))).status, 503);

  const insecureOrigin = fixture({ origin: "http://preview.example" });
  assert.equal((await insecureOrigin.handler(request({ business_id: BUSINESS_ID }))).status, 503);
});

test("customer portal rejects oversized request bodies before Stripe", async () => {
  const { handler, createCalls } = fixture();
  const response = await handler(request({
    business_id: BUSINESS_ID,
    padding: "x".repeat(20_000),
  }));

  assert.equal(response.status, 413);
  assert.equal(createCalls.length, 0);
});
