import assert from "node:assert/strict";
import test from "node:test";

import { APPROVED_STRIPE_EVENTS, createBillingService } from "../../netlify/functions/_billing-service.mjs";

function fakeStore({ existing = null } = {}) {
  const applied = [];
  return {
    applied,
    async applyEvent(input) {
      applied.push(structuredClone(input));
      return { duplicate: false, stale: false, subscription: input.businessId ? { business_id: input.businessId, status: input.status } : null };
    },
    async readSubscription({ businessId }) {
      return existing?.business_id === businessId ? structuredClone(existing) : null;
    },
    async findSubscriptionByStripeIds({ stripeCustomerId, stripeSubscriptionId }) {
      if (!existing) return null;
      return (existing.stripe_customer_id === stripeCustomerId || existing.stripe_subscription_id === stripeSubscriptionId)
        ? structuredClone(existing) : null;
    },
  };
}

function subscriptionEvent(type, overrides = {}) {
  return {
    id: `evt_${type}`,
    type,
    created: 1790020800,
    data: {
      object: {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        metadata: { business_id: "tenant-a", plan_key: "founding_monthly" },
        items: { data: [{ price: { id: "price_test" } }] },
        current_period_end: 1792702800,
        ...overrides,
      },
    },
  };
}

test("the approved allowlist contains only the six billing lifecycle events", () => {
  assert.deepEqual([...APPROVED_STRIPE_EVENTS].sort(), [
    "checkout.session.completed",
    "customer.subscription.created",
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "invoice.paid",
    "invoice.payment_failed",
  ]);
});

test("subscription events use subscription metadata as the tenant binding", async () => {
  const store = fakeStore();
  const service = createBillingService({ store });

  const result = await service.processEvent(subscriptionEvent("customer.subscription.updated"));

  assert.equal(result.businessId, "tenant-a");
  assert.equal(store.applied[0].status, "active");
  assert.equal(store.applied[0].stripePriceId, "price_test");
  assert.equal(store.applied[0].currentPeriodEnd.toISOString(), "2026-10-22T21:00:00.000Z");
  assert.equal(store.applied[0].advanceLifecycle, true);
});

test("subscription deletion always normalizes to canceled", async () => {
  const store = fakeStore();
  const service = createBillingService({ store });

  await service.processEvent(subscriptionEvent("customer.subscription.deleted", { status: "active" }));

  assert.equal(store.applied[0].status, "canceled");
});

test("checkout completion records linkage without overriding an existing lifecycle status", async () => {
  const existing = {
    business_id: "tenant-a", status: "trialing", plan_key: "founding_monthly",
    stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_price_id: "price_test",
  };
  const store = fakeStore({ existing });
  const service = createBillingService({ store });
  await service.processEvent({
    id: "evt_checkout", type: "checkout.session.completed", created: 1790020800,
    data: { object: { id: "cs_1", customer: "cus_1", subscription: "sub_1", payment_status: "paid",
      metadata: { business_id: "tenant-a", plan_key: "founding_monthly" } } },
  });

  assert.equal(store.applied[0].status, "trialing");
  assert.equal(store.applied[0].stripeSubscriptionId, "sub_1");
  assert.equal(store.applied[0].advanceLifecycle, false);
});

test("new checkout linkage remains incomplete until a subscription event arrives", async () => {
  const store = fakeStore();
  const service = createBillingService({ store });
  await service.processEvent({
    id: "evt_checkout_new", type: "checkout.session.completed", created: 1790020800,
    data: { object: { id: "cs_2", customer: "cus_2", subscription: "sub_2",
      metadata: { business_id: "tenant-b", plan_key: "founding_monthly" } } },
  });

  assert.equal(store.applied[0].status, "incomplete");
});

test("paid invoices preserve the mapped subscription status", async () => {
  const existing = {
    business_id: "tenant-a", status: "active", plan_key: "founding_monthly",
    stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_price_id: "price_test",
  };
  const store = fakeStore({ existing });
  const service = createBillingService({ store });
  await service.processEvent({
    id: "evt_paid", type: "invoice.paid", created: 1790020800,
    data: { object: { id: "in_1", customer: "cus_1", subscription: "sub_1" } },
  });

  assert.equal(store.applied[0].businessId, "tenant-a");
  assert.equal(store.applied[0].status, "active");
  assert.equal(store.applied[0].advanceLifecycle, false);
});

test("failed invoices set the mapped subscription to past_due", async () => {
  const existing = {
    business_id: "tenant-a", status: "active", plan_key: "founding_monthly",
    stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_price_id: "price_test",
  };
  const store = fakeStore({ existing });
  const service = createBillingService({ store });
  await service.processEvent({
    id: "evt_failed", type: "invoice.payment_failed", created: 1790020800,
    data: { object: { id: "in_2", customer: "cus_1", subscription: "sub_1" } },
  });

  assert.equal(store.applied[0].status, "past_due");
});

test("an invoice without metadata or an existing subscription mapping fails closed", async () => {
  const service = createBillingService({ store: fakeStore() });
  await assert.rejects(
    service.processEvent({ id: "evt_invoice", type: "invoice.paid", created: 1790020800,
      data: { object: { customer: "cus_unknown", subscription: "sub_unknown" } } }),
    /TENANT_MAPPING_REQUIRED/,
  );
});

test("unsupported signed events are recorded as ignored", async () => {
  const store = fakeStore();
  const service = createBillingService({ store });

  const result = await service.processEvent({ id: "evt_other", type: "product.updated", created: 1790020800, data: { object: {} } });

  assert.equal(result.outcome, "ignored");
  assert.equal(store.applied[0].result, "ignored");
  assert.equal(store.applied[0].businessId, null);
});

test("malformed events fail before reaching the store", async () => {
  const store = fakeStore();
  const service = createBillingService({ store });

  await assert.rejects(service.processEvent({ id: "evt_bad", type: "invoice.paid", created: 0, data: {} }), /INVALID_STRIPE_EVENT/);
  assert.equal(store.applied.length, 0);
});


test("checkout completion records signed Stripe promotion attribution without changing billing semantics", async () => {
  const store = fakeStore();
  const acquisitions = [];
  const service = createBillingService({
    store,
    attributionStore: {
      recordAcquisition: async (input) => {
        acquisitions.push(structuredClone(input));
        return input;
      },
    },
    resolveCheckoutAttribution: async ({ checkoutSessionId, businessId, planKey }) => {
      assert.equal(checkoutSessionId, "cs_attr");
      assert.equal(businessId, "tenant-a");
      assert.equal(planKey, "growth_monthly");
      return {
        campaignCode: "STEVE20",
        stripePromotionCodeId: "promo_1",
        stripeCouponId: "coupon_1",
        sourceChannel: "podcast",
        campaignName: "TESD",
      };
    },
  });

  const result = await service.processEvent({
    id: "evt_checkout_attr",
    type: "checkout.session.completed",
    created: 1790334000,
    data: {
      object: {
        id: "cs_attr",
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { business_id: "tenant-a", plan_key: "growth_monthly" },
      },
    },
  });

  assert.equal(result.outcome, "processed");
  assert.equal(acquisitions.length, 1);
  assert.equal(acquisitions[0].businessId, "tenant-a");
  assert.equal(acquisitions[0].campaignCode, "STEVE20");
  assert.equal(acquisitions[0].acquisitionPlanKey, "growth_monthly");
  assert.equal(acquisitions[0].stripeCheckoutSessionId, "cs_attr");
});

test("checkout completion without a redeemed promotion code records no attribution", async () => {
  const store = fakeStore();
  let writes = 0;
  const service = createBillingService({
    store,
    attributionStore: {
      recordAcquisition: async () => { writes += 1; },
    },
    resolveCheckoutAttribution: async () => null,
  });

  await service.processEvent({
    id: "evt_checkout_no_attr",
    type: "checkout.session.completed",
    created: 1790334000,
    data: {
      object: {
        id: "cs_no_attr",
        customer: "cus_1",
        subscription: "sub_1",
        metadata: { business_id: "tenant-a", plan_key: "growth_monthly" },
      },
    },
  });

  assert.equal(writes, 0);
});
