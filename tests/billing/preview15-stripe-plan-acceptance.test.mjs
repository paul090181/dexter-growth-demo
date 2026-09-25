import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../netlify/functions/preview15-stripe-plan-acceptance.mjs", import.meta.url),
  "utf8",
);

test("plan acceptance is Preview 15-only and hard-bound to the test Stripe account", () => {
  assert.match(source, /startsWith\("deploy-preview-15--"\)/);
  assert.match(source, /acct_1UICQv41OQl1gXUm/);
  assert.match(source, /growthPrice\.livemode !== false/);
  assert.match(source, /proPrice\.livemode !== false/);
  assert.match(source, /production_touched: false/);
});

test("plan acceptance recreates stale metadata while requiring price-authoritative Pro sync", () => {
  assert.match(source, /plan_key: "growth_monthly"/);
  assert.match(source, /price: proPriceId/);
  assert.match(source, /stripePro\.metadata\?\.plan_key === "growth_monthly"/);
  assert.match(source, /row\?\.plan_key === "pro_monthly"/);
  assert.match(source, /plan_started_at_reset/);
  assert.match(source, /pro_entitlements_active/);
});

test("plan acceptance cleans up synthetic Stripe and database state", () => {
  assert.match(source, /subscriptions\.cancel/);
  assert.match(source, /customers\.del/);
  assert.match(source, /DELETE FROM stripe_webhook_events/);
  assert.match(source, /DELETE FROM growthwise_subscriptions/);
  assert.match(source, /DELETE FROM growthwise_tenants/);
  assert.match(source, /persisted_subscription_row/);
});
