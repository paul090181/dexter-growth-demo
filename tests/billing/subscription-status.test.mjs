import assert from "node:assert/strict";
import test from "node:test";

import { createSubscriptionStatusHandler } from "../../netlify/functions/subscription-status.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";

const URL = "https://preview.example/.netlify/functions/subscription-status";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

function authorizedRequest(businessId, key = "valid-key", tenantKey = "") {
  const headers = {};
  if (key) headers["x-growthwise-key"] = key;
  if (tenantKey) headers["x-growthwise-tenant-key"] = tenantKey;
  return new Request(`${URL}?business_id=${encodeURIComponent(businessId)}`, {
    headers,
  });
}

function fixture(row = null) {
  const reads = [];
  const handler = createSubscriptionStatusHandler({
    authorized: (request) => ({ ok: request.headers.get("x-growthwise-key") === "valid-key" }),
    store: {
      readSubscription: async (input) => {
        reads.push(input);
        return row;
      },
    },
    tenants: new Set(["growthwise-dev", "dexters-hats"]),
    tenantStore: {
      readTenantAuth: async ({ businessId }) => businessId === "tenant-self-abcdef123456"
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null,
    },
  });
  return { handler, reads };
}

test("subscription status requires the GrowthWise key", async () => {
  const { handler, reads } = fixture();
  const response = await handler(new Request(`${URL}?business_id=dexters-hats`));

  assert.equal(response.status, 401);
  assert.equal(reads.length, 0);
});

test("Dexter pilot status is returned without Stripe identifiers", async () => {
  const { handler } = fixture({
    business_id: "dexters-hats",
    access_source: "pilot",
    plan_key: "founding_monthly",
    status: "pilot",
    current_period_end: null,
    stripe_customer_id: "cus_secret",
    stripe_subscription_id: "sub_secret",
    stripe_price_id: "price_secret",
  });
  const response = await handler(authorizedRequest("dexters-hats"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    business_id: "dexters-hats",
    access_source: "pilot",
    plan_key: "founding_monthly",
    status: "pilot",
    current_period_end: null,
    access_granted: true,
  });
});

test("subscription status rejects unknown tenants before reading storage", async () => {
  const { handler, reads } = fixture();
  const response = await handler(authorizedRequest("attacker-tenant"));

  assert.equal(response.status, 404);
  assert.equal(reads.length, 0);
});

test("subscription status returns a neutral unconfigured state for a known tenant", async () => {
  const { handler } = fixture(null);
  const response = await handler(authorizedRequest("growthwise-dev"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    business_id: "growthwise-dev",
    access_source: null,
    plan_key: null,
    status: "not_subscribed",
    current_period_end: null,
    access_granted: false,
  });
});

test("subscription status allows only GET", async () => {
  const { handler } = fixture();
  const response = await handler(new Request(`${URL}?business_id=dexters-hats`, {
    method: "POST",
    headers: { "x-growthwise-key": "valid-key" },
  }));
  assert.equal(response.status, 405);
});

test("a registered tenant is locked before signed webhook activation", async () => {
  const { handler } = fixture(null);
  const response = await handler(authorizedRequest("tenant-self-abcdef123456", "", TENANT_KEY));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    business_id: "tenant-self-abcdef123456",
    access_source: null,
    plan_key: null,
    status: "not_subscribed",
    current_period_end: null,
    access_granted: false,
  });
});

test("active and trialing Stripe tenants receive access from server state", async () => {
  for (const status of ["active", "trialing"]) {
    const { handler } = fixture({
      business_id: "tenant-self-abcdef123456",
      access_source: "stripe",
      plan_key: "founding_monthly",
      status,
      current_period_end: "2026-10-23T00:00:00.000Z",
    });
    const response = await handler(authorizedRequest("tenant-self-abcdef123456", "", TENANT_KEY));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).access_granted, true);
  }
});

test("incomplete Stripe state does not grant paid access", async () => {
  const { handler } = fixture({
    business_id: "tenant-self-abcdef123456",
    access_source: "stripe",
    plan_key: "founding_monthly",
    status: "incomplete",
    current_period_end: null,
  });
  const response = await handler(authorizedRequest("tenant-self-abcdef123456", "", TENANT_KEY));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).access_granted, false);
});

test("one tenant key cannot read another tenant subscription", async () => {
  const { handler, reads } = fixture({
    business_id: "tenant-other-abcdef123456", access_source: "stripe", status: "active",
  });
  const response = await handler(authorizedRequest("tenant-other-abcdef123456", "", TENANT_KEY));

  assert.equal(response.status, 401);
  assert.equal(reads.length, 0);
});
