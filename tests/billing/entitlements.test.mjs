import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOMER_FEATURES,
  PLAN_CATALOG,
  hasEntitlement,
  resolveSubscriptionEntitlements,
} from "../../netlify/functions/_entitlements.mjs";

const ACTIVE = { access_source: "stripe", status: "active" };

test("plan catalog exposes the approved launch price ladder", () => {
  assert.equal(PLAN_CATALOG.founding_monthly.monthly_price_usd, 49);
  assert.equal(PLAN_CATALOG.starter_monthly.monthly_price_usd, 99);
  assert.equal(PLAN_CATALOG.growth_monthly.monthly_price_usd, 199);
  assert.equal(PLAN_CATALOG.pro_monthly.monthly_price_usd, 399);
});

test("founding members receive the full customer feature set", () => {
  const state = resolveSubscriptionEntitlements({
    ...ACTIVE,
    plan_key: "founding_monthly",
  });
  assert.equal(state.access_granted, true);
  assert.equal(state.plan_tier, "founding");
  assert.deepEqual(new Set(state.entitlements), new Set(CUSTOMER_FEATURES));
});

test("starter gets core AI but not growth or pro automation", () => {
  const state = resolveSubscriptionEntitlements({
    ...ACTIVE,
    plan_key: "starter_monthly",
  });
  assert.equal(hasEntitlement(state, "lead_reply_drafting"), true);
  assert.equal(hasEntitlement(state, "promotion_content"), true);
  assert.equal(hasEntitlement(state, "inventory_connection"), false);
  assert.equal(hasEntitlement(state, "multi_channel_automation"), false);
});

test("growth receives a 30-day pro experience and then falls back to growth automatically", () => {
  const started = "2026-09-01T12:00:00.000Z";
  const during = resolveSubscriptionEntitlements({
    ...ACTIVE,
    plan_key: "growth_monthly",
    plan_started_at: started,
  }, { now: new Date("2026-09-15T12:00:00.000Z") });

  assert.equal(during.effective_tier, "pro_experience");
  assert.equal(during.pro_experience.active, true);
  assert.equal(during.pro_experience.ends_at, "2026-10-01T12:00:00.000Z");
  assert.equal(during.pro_experience.converts_automatically, false);
  assert.equal(during.pro_experience.fallback_plan_key, "growth_monthly");
  assert.equal(hasEntitlement(during, "advanced_ai_automation"), true);

  const after = resolveSubscriptionEntitlements({
    ...ACTIVE,
    plan_key: "growth_monthly",
    plan_started_at: started,
  }, { now: new Date("2026-10-02T12:00:00.000Z") });

  assert.equal(after.effective_tier, "growth");
  assert.equal(after.pro_experience.active, false);
  assert.equal(hasEntitlement(after, "inventory_connection"), true);
  assert.equal(hasEntitlement(after, "advanced_ai_automation"), false);
  assert.equal(hasEntitlement(after, "multi_location"), false);
});

test("pro receives all customer features", () => {
  const state = resolveSubscriptionEntitlements({
    ...ACTIVE,
    plan_key: "pro_monthly",
  });
  assert.equal(state.plan_tier, "pro");
  assert.deepEqual(new Set(state.entitlements), new Set(CUSTOMER_FEATURES));
});

test("inactive billing fails closed even when the plan normally includes a feature", () => {
  for (const status of ["past_due", "unpaid", "canceled", "incomplete"]) {
    const state = resolveSubscriptionEntitlements({
      access_source: "stripe",
      plan_key: "pro_monthly",
      status,
    });
    assert.equal(state.access_granted, false);
    assert.equal(hasEntitlement(state, "advanced_ai_automation"), false);
  }
});

test("unknown plan keys fail closed", () => {
  const state = resolveSubscriptionEntitlements({
    ...ACTIVE,
    plan_key: "attacker_plan",
  });
  assert.equal(state.access_granted, true);
  assert.deepEqual(state.entitlements, []);
  assert.equal(hasEntitlement(state, "lead_reply_drafting"), false);
});
