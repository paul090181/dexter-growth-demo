import assert from "node:assert/strict";
import test from "node:test";

import { createStripePlanChangeHandler } from "../../netlify/functions/stripe-plan-change.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";

const BUSINESS_ID = "tenant-self-abcdef123456";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;
const URL = "https://preview.example/.netlify/functions/stripe-plan-change";

function request(body = {}, tenantKey = TENANT_KEY) {
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-tenant-key": tenantKey,
    },
    body: JSON.stringify(body),
  });
}

function fixture(overrides = {}) {
  const retrieveCalls = [];
  const portalCalls = [];
  const stripe = {
    subscriptions: {
      retrieve: async (id) => {
        retrieveCalls.push(id);
        return {
          id,
          customer: "cus_server",
          items: { data: [{ id: "si_server", price: { id: "price_growth" } }] },
        };
      },
    },
    billingPortal: {
      sessions: {
        create: async (input) => {
          portalCalls.push(input);
          return { url: "https://billing.stripe.com/p/session/test_plan_change" };
        },
      },
    },
  };

  const subscription = {
    business_id: BUSINESS_ID,
    access_source: "stripe",
    plan_key: "growth_monthly",
    status: "active",
    stripe_customer_id: "cus_server",
    stripe_subscription_id: "sub_server",
  };

  const handler = createStripePlanChangeHandler({
    stripe,
    priceIds: {
      founding_monthly: "price_founding",
      starter_monthly: "price_starter",
      growth_monthly: "price_growth",
      pro_monthly: "price_pro",
    },
    portalConfigurationId: "bpc_test123",
    origin: "https://deploy-preview-15--euphonious-beijinho-db4b4d.netlify.app",
    tenantStore: {
      readTenantAuth: async ({ businessId }) => businessId === BUSINESS_ID
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null,
    },
    billingStore: { readSubscription: async () => subscription },
    ...overrides,
  });
  return { handler, stripe, subscription, retrieveCalls, portalCalls };
}

test("plan change requires exact tenant credentials", async () => {
  const { handler, retrieveCalls } = fixture();
  const response = await handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }, "wrong"));
  assert.equal(response.status, 401);
  assert.equal(retrieveCalls.length, 0);
});

test("growth tenant can open a Stripe-hosted Pro confirmation flow", async () => {
  const { handler, retrieveCalls, portalCalls } = fixture();
  const response = await handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
    price: "price_attacker",
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    portal_url: "https://billing.stripe.com/p/session/test_plan_change",
    target_plan_key: "pro_monthly",
  });
  assert.deepEqual(retrieveCalls, ["sub_server"]);
  assert.equal(portalCalls.length, 1);
  assert.equal(portalCalls[0].customer, "cus_server");
  assert.equal(portalCalls[0].configuration, "bpc_test123");
  assert.equal(portalCalls[0].flow_data.type, "subscription_update_confirm");
  assert.equal(portalCalls[0].flow_data.subscription_update_confirm.subscription, "sub_server");
  assert.deepEqual(portalCalls[0].flow_data.subscription_update_confirm.items, [{
    id: "si_server",
    price: "price_pro",
    quantity: 1,
  }]);
  assert.doesNotMatch(JSON.stringify(body), /cus_server|sub_server|si_server/);
});

test("self-service plan changes exclude grandfathered Founding subscriptions", async () => {
  const base = fixture();
  const handler = createStripePlanChangeHandler({
    stripe: base.stripe,
    priceIds: {
      founding_monthly: "price_founding",
      starter_monthly: "price_starter",
      growth_monthly: "price_growth",
      pro_monthly: "price_pro",
    },
    portalConfigurationId: "bpc_test123",
    origin: "https://deploy-preview-15--euphonious-beijinho-db4b4d.netlify.app",
    tenantStore: {
      readTenantAuth: async ({ businessId }) => businessId === BUSINESS_ID
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null,
    },
    billingStore: {
      readSubscription: async () => ({ ...base.subscription, plan_key: "founding_monthly" }),
    },
  });
  const response = await handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }));
  assert.equal(response.status, 409);
  assert.equal(base.portalCalls.length, 0);
});

test("plan change rejects same-plan, inactive billing, and unknown plans", async () => {
  const same = fixture();
  assert.equal((await same.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "growth_monthly",
  }))).status, 409);

  const inactive = fixture({
    billingStore: {
      readSubscription: async () => ({ ...fixture().subscription, status: "past_due" }),
    },
  });
  assert.equal((await inactive.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }))).status, 409);

  const unknown = fixture();
  assert.equal((await unknown.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "enterprise_monthly",
  }))).status, 400);
});

test("plan change fails closed if the target price or portal configuration is missing", async () => {
  const missingPrice = fixture({
    priceIds: {
      founding_monthly: "price_founding",
      starter_monthly: "price_starter",
      growth_monthly: "price_growth",
      pro_monthly: "",
    },
  });
  assert.equal((await missingPrice.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }))).status, 503);

  const missingPortal = fixture({ portalConfigurationId: "" });
  assert.equal((await missingPortal.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }))).status, 503);
});

test("plan change verifies the stored Stripe customer and requires exactly one subscription item", async () => {
  const mismatch = fixture({
    stripe: {
      subscriptions: {
        retrieve: async () => ({
          customer: "cus_other",
          items: { data: [{ id: "si_server" }] },
        }),
      },
      billingPortal: {
        sessions: { create: async () => { throw new Error("should not run"); } },
      },
    },
  });
  assert.equal((await mismatch.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }))).status, 409);

  const multi = fixture({
    stripe: {
      subscriptions: {
        retrieve: async () => ({
          customer: "cus_server",
          items: { data: [{ id: "si_1" }, { id: "si_2" }] },
        }),
      },
      billingPortal: {
        sessions: { create: async () => { throw new Error("should not run"); } },
      },
    },
  });
  assert.equal((await multi.handler(request({
    business_id: BUSINESS_ID,
    plan_key: "pro_monthly",
  }))).status, 409);
});
