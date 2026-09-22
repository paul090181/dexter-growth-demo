import assert from "node:assert/strict";
import test from "node:test";

import { createSubscriptionStatusHandler } from "../../netlify/functions/subscription-status.mjs";

const URL = "https://preview.example/.netlify/functions/subscription-status";

function authorizedRequest(businessId, key = "valid-key") {
  return new Request(`${URL}?business_id=${encodeURIComponent(businessId)}`, {
    headers: { "x-growthwise-key": key },
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
