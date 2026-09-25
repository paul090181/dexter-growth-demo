function stringId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  return "";
}

function promoIdFromDiscount(discount) {
  if (!discount || typeof discount !== "object") return "";
  return stringId(discount.promotion_code)
    || stringId(discount.promotionCode)
    || stringId(discount.discount?.promotion_code)
    || stringId(discount.discount?.promotionCode);
}

function checkoutDiscounts(session) {
  const direct = Array.isArray(session?.discounts) ? session.discounts : [];
  const breakdown = Array.isArray(session?.total_details?.breakdown?.discounts)
    ? session.total_details.breakdown.discounts : [];
  return [...direct, ...breakdown];
}

function couponIdFromPromotion(promotion) {
  return stringId(promotion?.promotion?.coupon)
    || stringId(promotion?.coupon)
    || stringId(promotion?.promotion?.coupon?.id);
}

function metadata(value) {
  return value?.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? value.metadata : {};
}

export function createStripeCheckoutAttributionResolver({ stripe } = {}) {
  return async function resolveCheckoutAttribution({ checkoutSessionId } = {}) {
    const sessionId = stringId(checkoutSessionId);
    if (!sessionId || !stripe?.checkout?.sessions?.retrieve || !stripe?.promotionCodes?.retrieve) {
      return null;
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["total_details.breakdown"],
    });

    const promotionCodeId = checkoutDiscounts(session)
      .map(promoIdFromDiscount)
      .find(Boolean);
    if (!promotionCodeId) return null;

    const promotion = await stripe.promotionCodes.retrieve(promotionCodeId);
    const code = typeof promotion?.code === "string" ? promotion.code.trim() : "";
    if (!code) return null;

    const meta = metadata(promotion);
    return {
      campaignCode: code,
      stripePromotionCodeId: promotionCodeId,
      stripeCouponId: couponIdFromPromotion(promotion) || null,
      sourceChannel: typeof meta.channel === "string" ? meta.channel.trim().slice(0, 120) : null,
      campaignName: typeof meta.campaign_name === "string" ? meta.campaign_name.trim().slice(0, 160) : null,
    };
  };
}
