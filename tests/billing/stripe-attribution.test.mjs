import assert from "node:assert/strict";
import test from "node:test";

import { createStripeCheckoutAttributionResolver } from "../../netlify/functions/_stripe-attribution.mjs";

test("Stripe attribution resolver returns the customer-facing promotion code and safe campaign metadata", async () => {
  const calls = [];
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (id, options) => {
          calls.push({ kind: "session", id, options });
          return {
            id,
            total_details: {
              breakdown: {
                discounts: [{
                  amount: 3980,
                  discount: { promotion_code: "promo_radio_123" },
                }],
              },
            },
          };
        },
      },
    },
    promotionCodes: {
      retrieve: async (id) => {
        calls.push({ kind: "promotion", id });
        return {
          id,
          code: "STEVE20",
          promotion: { coupon: "coupon_20_three_months" },
          metadata: {
            channel: "podcast",
            campaign_name: "Tell Em Steve-Dave test campaign",
          },
        };
      },
    },
  };

  const resolve = createStripeCheckoutAttributionResolver({ stripe });
  const result = await resolve({ checkoutSessionId: "cs_test_123" });

  assert.deepEqual(result, {
    campaignCode: "STEVE20",
    stripePromotionCodeId: "promo_radio_123",
    stripeCouponId: "coupon_20_three_months",
    sourceChannel: "podcast",
    campaignName: "Tell Em Steve-Dave test campaign",
  });
  assert.deepEqual(calls[0], {
    kind: "session",
    id: "cs_test_123",
    options: { expand: ["total_details.breakdown"] },
  });
  assert.equal(calls[1].id, "promo_radio_123");
});

test("Stripe attribution resolver accepts direct checkout discounts shape", async () => {
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          discounts: [{ promotion_code: { id: "promo_direct" } }],
        }),
      },
    },
    promotionCodes: {
      retrieve: async () => ({
        id: "promo_direct",
        code: "WGR20",
        coupon: { id: "coupon_legacy" },
        metadata: {},
      }),
    },
  };

  const resolve = createStripeCheckoutAttributionResolver({ stripe });
  const result = await resolve({ checkoutSessionId: "cs_test_direct" });

  assert.equal(result.campaignCode, "WGR20");
  assert.equal(result.stripePromotionCodeId, "promo_direct");
  assert.equal(result.stripeCouponId, "coupon_legacy");
});

test("checkout without a promotion code produces no acquisition attribution", async () => {
  let promotionReads = 0;
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async () => ({
          total_details: { breakdown: { discounts: [] } },
        }),
      },
    },
    promotionCodes: {
      retrieve: async () => { promotionReads += 1; return {}; },
    },
  };

  const resolve = createStripeCheckoutAttributionResolver({ stripe });
  assert.equal(await resolve({ checkoutSessionId: "cs_test_none" }), null);
  assert.equal(promotionReads, 0);
});
