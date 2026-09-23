import assert from "node:assert/strict";
import test from "node:test";

import { createBillingStore } from "../../netlify/functions/_billing-store.mjs";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeDatabase({ subscriptions = [], tenants = ["tenant-a"], failUpsert = false } = {}) {
  const state = {
    subscriptions: new Map(subscriptions.map((row) => [row.business_id, clone(row)])),
    tenants: new Set(tenants),
    events: new Map(),
  };

  const query = async (text, values = [], transactionState = state) => {
    if (text.includes("FROM growthwise_tenants") && text.includes("registered_tenant")) {
      const registered = transactionState.tenants.has(values[0]) || transactionState.subscriptions.has(values[0]);
      return { rows: registered ? [{ business_id: values[0] }] : [] };
    }
    if (text.includes("FROM growthwise_subscriptions") && text.includes("stripe_customer_id = $1")) {
      const rows = [...transactionState.subscriptions.values()].filter((candidate) => (
        (values[0] && candidate.stripe_customer_id === values[0])
        || (values[1] && candidate.stripe_subscription_id === values[1])
      ));
      return { rows: rows.slice(0, 2).map(clone) };
    }
    if (text.includes("FROM growthwise_subscriptions") && text.includes("business_id <> $1")) {
      const row = [...transactionState.subscriptions.values()].find((candidate) => (
        candidate.business_id !== values[0]
        && ((values[1] && candidate.stripe_customer_id === values[1])
          || (values[2] && candidate.stripe_subscription_id === values[2]))
      ));
      return { rows: row ? [{ business_id: row.business_id }] : [] };
    }
    if (text.includes("FROM growthwise_subscriptions") && text.includes("WHERE business_id = $1")) {
      const row = transactionState.subscriptions.get(values[0]);
      return { rows: row ? [clone(row)] : [] };
    }
    if (text.includes("INSERT INTO stripe_webhook_events")) {
      if (transactionState.events.has(values[0])) return { rows: [] };
      transactionState.events.set(values[0], {
        stripe_event_id: values[0], event_type: values[1], event_created_at: values[2],
        business_id: values[3], result: values[4],
      });
      return { rows: [{ stripe_event_id: values[0] }] };
    }
    if (text.includes("UPDATE stripe_webhook_events") && text.includes("SET result")) {
      const row = transactionState.events.get(values[0]);
      if (row) row.result = values[1];
      return { rows: row ? [clone(row)] : [] };
    }
    if (text.includes("INSERT INTO growthwise_subscriptions")) {
      if (failUpsert) throw new Error("synthetic database failure");
      const existing = transactionState.subscriptions.get(values[0]);
      const row = {
        business_id: values[0],
        access_source: existing?.access_source === "pilot" ? "pilot" : "stripe",
        plan_key: existing?.access_source === "pilot" ? existing.plan_key : values[1],
        status: existing?.access_source === "pilot" ? "pilot" : values[2],
        stripe_customer_id: values[3] ?? existing?.stripe_customer_id ?? null,
        stripe_subscription_id: values[4] ?? existing?.stripe_subscription_id ?? null,
        stripe_price_id: values[5] ?? existing?.stripe_price_id ?? null,
        current_period_end: values[6],
        last_event_created_at: values[7] ?? existing?.last_event_created_at ?? null,
        created_at: existing?.created_at ?? new Date("2026-09-21T00:00:00Z"),
        updated_at: new Date("2026-09-21T20:00:00Z"),
      };
      transactionState.subscriptions.set(values[0], row);
      return { rows: [clone(row)] };
    }
    throw new Error(`Unexpected SQL: ${text}`);
  };

  const pool = {
    async query(text, values) { return query(text, values, state); },
    async connect() {
      let tx = null;
      return {
        async query(text, values) {
          if (text === "BEGIN") {
            tx = { subscriptions: new Map([...state.subscriptions].map(([k, v]) => [k, clone(v)])), tenants: new Set(state.tenants), events: new Map([...state.events].map(([k, v]) => [k, clone(v)])) };
            return { rows: [] };
          }
          if (text === "COMMIT") {
            state.subscriptions = tx.subscriptions;
            state.tenants = tx.tenants;
            state.events = tx.events;
            tx = null;
            return { rows: [] };
          }
          if (text === "ROLLBACK") { tx = null; return { rows: [] }; }
          return query(text, values, tx ?? state);
        },
        release() {},
      };
    },
  };
  return { pool, state };
}

function eventAt(eventId, status, at, businessId = "tenant-a", overrides = {}) {
  return {
    eventId,
    eventType: "customer.subscription.updated",
    eventCreatedAt: new Date(at),
    businessId,
    planKey: "founding_monthly",
    status,
    stripeCustomerId: "cus_shared",
    stripeSubscriptionId: "sub_shared",
    stripePriceId: "price_test",
    currentPeriodEnd: null,
    result: "processed",
    advanceLifecycle: true,
    ...overrides,
  };
}

test("duplicate events are successful no-ops", async () => {
  const db = fakeDatabase();
  const store = createBillingStore({ getPool: async () => db.pool });
  const event = eventAt("evt_1", "active", "2026-09-21T20:00:00Z");

  assert.equal((await store.applyEvent(event)).duplicate, false);
  assert.equal((await store.applyEvent(event)).duplicate, true);
  assert.equal(db.state.events.size, 1);
});

test("older events cannot overwrite newer subscription state", async () => {
  const db = fakeDatabase();
  const store = createBillingStore({ getPool: async () => db.pool });
  await store.applyEvent(eventAt("evt_new", "active", "2026-09-21T20:00:00Z"));
  const older = await store.applyEvent(eventAt("evt_old", "past_due", "2026-09-21T19:00:00Z"));

  assert.equal(older.stale, true);
  assert.equal((await store.readSubscription({ businessId: "tenant-a" })).status, "active");
  assert.equal(db.state.events.get("evt_old").result, "ignored");
});

test("Stripe identifiers cannot be rebound to another business", async () => {
  const db = fakeDatabase({ tenants: ["tenant-a", "tenant-b"] });
  const store = createBillingStore({ getPool: async () => db.pool });
  await store.applyEvent(eventAt("evt_a", "active", "2026-09-21T20:00:00Z", "tenant-a"));

  await assert.rejects(
    store.applyEvent(eventAt("evt_b", "active", "2026-09-21T21:00:00Z", "tenant-b")),
    /STRIPE_BINDING_CONFLICT/,
  );
  assert.equal(db.state.events.has("evt_b"), false);
});

test("a failed subscription update rolls back the event record", async () => {
  const db = fakeDatabase({ failUpsert: true });
  const store = createBillingStore({ getPool: async () => db.pool });

  await assert.rejects(
    store.applyEvent(eventAt("evt_failure", "active", "2026-09-21T20:00:00Z")),
    /BILLING_EVENT_APPLY_FAILED/,
  );
  assert.equal(db.state.events.has("evt_failure"), false);
});

test("Stripe events never downgrade Dexter pilot access", async () => {
  const pilot = {
    business_id: "dexters-hats", access_source: "pilot", plan_key: "founding_monthly", status: "pilot",
    stripe_customer_id: null, stripe_subscription_id: null, stripe_price_id: null,
    current_period_end: null, last_event_created_at: null,
    created_at: new Date("2026-09-21T00:00:00Z"), updated_at: new Date("2026-09-21T00:00:00Z"),
  };
  const db = fakeDatabase({ subscriptions: [pilot] });
  const store = createBillingStore({ getPool: async () => db.pool });

  const result = await store.applyEvent(eventAt(
    "evt_cancel", "canceled", "2026-09-21T20:00:00Z", "dexters-hats",
    { stripeCustomerId: "cus_dexter", stripeSubscriptionId: "sub_dexter" },
  ));

  assert.equal(result.subscription.access_source, "pilot");
  assert.equal(result.subscription.status, "pilot");
});

test("Dexter pilot access keeps its Stripe linkage for later invoice events", async () => {
  const pilot = {
    business_id: "dexters-hats", access_source: "pilot", plan_key: "founding_monthly", status: "pilot",
    stripe_customer_id: null, stripe_subscription_id: null, stripe_price_id: null,
    current_period_end: null, last_event_created_at: null,
  };
  const db = fakeDatabase({ subscriptions: [pilot] });
  const store = createBillingStore({ getPool: async () => db.pool });

  const result = await store.applyEvent(eventAt(
    "evt_link", "active", "2026-09-21T20:00:00Z", "dexters-hats",
    { stripeCustomerId: "cus_dexter", stripeSubscriptionId: "sub_dexter", stripePriceId: "price_founding" },
  ));

  assert.equal(result.subscription.access_source, "pilot");
  assert.equal(result.subscription.status, "pilot");
  assert.equal(result.subscription.stripe_customer_id, "cus_dexter");
  assert.equal(result.subscription.stripe_subscription_id, "sub_dexter");
  assert.equal((await store.findSubscriptionByStripeIds({ stripeSubscriptionId: "sub_dexter" })).business_id, "dexters-hats");
});

test("invoice processing can resolve one durable Stripe binding", async () => {
  const db = fakeDatabase();
  const store = createBillingStore({ getPool: async () => db.pool });
  await store.applyEvent(eventAt("evt_bound", "active", "2026-09-21T20:00:00Z"));

  const found = await store.findSubscriptionByStripeIds({
    stripeCustomerId: "cus_shared", stripeSubscriptionId: "sub_shared",
  });

  assert.equal(found.business_id, "tenant-a");
  assert.equal(found.status, "active");
});

test("webhook events cannot create subscriptions for unregistered metadata", async () => {
  const db = fakeDatabase({ tenants: [] });
  const store = createBillingStore({ getPool: async () => db.pool });

  await assert.rejects(
    store.applyEvent(eventAt("evt_unregistered", "active", "2026-09-21T20:00:00Z", "made-up-tenant")),
    /TENANT_NOT_REGISTERED/,
  );
  assert.equal(db.state.events.has("evt_unregistered"), false);
  assert.equal(db.state.subscriptions.has("made-up-tenant"), false);
});

test("later checkout linkage cannot make an earlier subscription activation stale", async () => {
  const db = fakeDatabase();
  const store = createBillingStore({ getPool: async () => db.pool });

  const checkout = await store.applyEvent(eventAt(
    "evt_checkout_later", "incomplete", "2026-09-21T20:00:01Z", "tenant-a",
    { eventType: "checkout.session.completed", advanceLifecycle: false },
  ));
  const subscription = await store.applyEvent(eventAt(
    "evt_subscription_earlier", "active", "2026-09-21T20:00:00Z", "tenant-a",
    { eventType: "customer.subscription.created", advanceLifecycle: true },
  ));

  assert.equal(checkout.subscription.status, "incomplete");
  assert.equal(subscription.stale, false);
  assert.equal(subscription.subscription.status, "active");
  assert.equal((await store.readSubscription({ businessId: "tenant-a" })).status, "active");
});
