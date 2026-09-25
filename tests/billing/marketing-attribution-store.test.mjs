import assert from "node:assert/strict";
import test from "node:test";

import { createMarketingAttributionStore } from "../../netlify/functions/_marketing-attribution-store.mjs";

function fakePool() {
  const byBusiness = new Map();
  const bySession = new Map();
  return {
    state: { byBusiness, bySession },
    async query(sql, values) {
      if (sql.includes("INSERT INTO growthwise_acquisition_attribution")) {
        const businessId = values[0];
        const checkoutSessionId = values[4];
        if (byBusiness.has(businessId) || bySession.has(checkoutSessionId)) return { rows: [] };
        const row = {
          business_id: businessId,
          source_kind: "stripe_promotion_code",
          campaign_code: values[1],
          stripe_promotion_code_id: values[2],
          stripe_coupon_id: values[3],
          stripe_checkout_session_id: checkoutSessionId,
          acquisition_plan_key: values[5],
          source_channel: values[6],
          campaign_name: values[7],
          attributed_at: values[8],
          created_at: new Date("2026-09-25T12:00:00Z"),
        };
        byBusiness.set(businessId, row);
        bySession.set(checkoutSessionId, row);
        return { rows: [structuredClone(row)] };
      }
      if (sql.includes("FROM growthwise_acquisition_attribution")) {
        const row = byBusiness.get(values[0]);
        return { rows: row ? [structuredClone(row)] : [] };
      }
      throw new Error("Unexpected SQL");
    },
  };
}

test("acquisition attribution stores a normalized first-touch campaign code", async () => {
  const pool = fakePool();
  const store = createMarketingAttributionStore({ getPool: async () => pool });

  const row = await store.recordAcquisition({
    businessId: "tenant-a",
    campaignCode: "steve20",
    stripePromotionCodeId: "promo_1",
    stripeCouponId: "coupon_1",
    stripeCheckoutSessionId: "cs_1",
    acquisitionPlanKey: "growth_monthly",
    sourceChannel: "podcast",
    campaignName: "TESD",
    attributedAt: new Date("2026-09-25T11:00:00Z"),
  });

  assert.equal(row.campaign_code, "STEVE20");
  assert.equal(row.acquisition_plan_key, "growth_monthly");
  assert.equal(row.source_channel, "podcast");
});

test("later checkout attribution cannot overwrite the tenant's original acquisition source", async () => {
  const pool = fakePool();
  const store = createMarketingAttributionStore({ getPool: async () => pool });

  await store.recordAcquisition({
    businessId: "tenant-a",
    campaignCode: "STEVE20",
    stripePromotionCodeId: "promo_first",
    stripeCheckoutSessionId: "cs_first",
    acquisitionPlanKey: "growth_monthly",
    attributedAt: new Date("2026-09-25T11:00:00Z"),
  });

  const later = await store.recordAcquisition({
    businessId: "tenant-a",
    campaignCode: "OTHER20",
    stripePromotionCodeId: "promo_later",
    stripeCheckoutSessionId: "cs_later",
    acquisitionPlanKey: "pro_monthly",
    attributedAt: new Date("2026-10-25T11:00:00Z"),
  });

  assert.equal(later, null);
  const saved = await store.readAcquisition({ businessId: "tenant-a" });
  assert.equal(saved.campaign_code, "STEVE20");
  assert.equal(saved.acquisition_plan_key, "growth_monthly");
});
