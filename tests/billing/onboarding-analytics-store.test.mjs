import assert from "node:assert/strict";
import test from "node:test";

import {
  ALLOWED_EVENTS,
  createOnboardingAnalyticsStore,
} from "../../netlify/functions/_onboarding-analytics-store.mjs";

function pool(rows = []) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("onboarding analytics store records only approved milestone names", async () => {
  const db = pool([{
    business_id: "north-star-books",
    event_name: "workspace_opened",
    occurred_at: new Date("2026-09-25T20:00:00.000Z"),
    occurred_on: "2026-09-25",
  }]);
  const store = createOnboardingAnalyticsStore({ getPool: async () => db });

  const row = await store.recordEvent({
    businessId: "north-star-books",
    eventName: "workspace_opened",
    occurredAt: new Date("2026-09-25T20:00:00.000Z"),
  });

  assert.equal(row.event_name, "workspace_opened");
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /ON CONFLICT \(business_id, event_name, occurred_on\) DO NOTHING/);
  assert.equal(db.calls[0].params[0], "north-star-books");
  assert.equal(db.calls[0].params[1], "workspace_opened");

  await assert.rejects(
    store.recordEvent({ businessId: "north-star-books", eventName: "customer_message_text" }),
    /INVALID_ONBOARDING_EVENT/,
  );
  assert.equal(ALLOWED_EVENTS.has("customer_message_text"), false);
});

test("onboarding analytics store reads funnel rows joined to attribution and subscriptions", async () => {
  const db = pool([]);
  const store = createOnboardingAnalyticsStore({ getPool: async () => db });
  await store.listFunnelRows();

  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /growthwise_acquisition_attribution/);
  assert.match(db.calls[0].sql, /growthwise_subscriptions/);
  assert.match(db.calls[0].sql, /returned_after_first_value/);
  assert.match(db.calls[0].sql, /business_pulse_loaded/);
  assert.match(db.calls[0].sql, /ai_workflow_used/);
});
