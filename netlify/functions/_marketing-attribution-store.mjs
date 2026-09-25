async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function clean(value, max = 240) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export function createMarketingAttributionStore({ getPool = netlifyPool } = {}) {
  async function recordAcquisition(input = {}) {
    const businessId = clean(input.businessId, 200);
    const campaignCode = clean(input.campaignCode, 120);
    const promotionCodeId = clean(input.stripePromotionCodeId, 200);
    const checkoutSessionId = clean(input.stripeCheckoutSessionId, 200);
    const planKey = clean(input.acquisitionPlanKey, 120);
    const attributedAt = validDate(input.attributedAt);

    if (!businessId || !campaignCode || !promotionCodeId || !checkoutSessionId || !planKey || !attributedAt) {
      throw new Error("INVALID_ACQUISITION_ATTRIBUTION");
    }

    const couponId = clean(input.stripeCouponId, 200) || null;
    const sourceChannel = clean(input.sourceChannel, 120) || null;
    const campaignName = clean(input.campaignName, 160) || null;

    const sql = `
      INSERT INTO growthwise_acquisition_attribution
        (business_id, source_kind, campaign_code, stripe_promotion_code_id,
         stripe_coupon_id, stripe_checkout_session_id, acquisition_plan_key,
         source_channel, campaign_name, attributed_at)
      VALUES ($1, 'stripe_promotion_code', $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (business_id) DO NOTHING
      RETURNING business_id, source_kind, campaign_code, stripe_promotion_code_id,
                stripe_coupon_id, stripe_checkout_session_id, acquisition_plan_key,
                source_channel, campaign_name, attributed_at, created_at
    `;

    try {
      const result = await (await getPool()).query(sql, [
        businessId,
        campaignCode.toUpperCase(),
        promotionCodeId,
        couponId,
        checkoutSessionId,
        planKey,
        sourceChannel,
        campaignName,
        attributedAt,
      ]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (error?.code === "23505") return null;
      throw new Error("ACQUISITION_ATTRIBUTION_WRITE_FAILED", { cause: error });
    }
  }

  async function readAcquisition({ businessId } = {}) {
    const id = clean(businessId, 200);
    if (!id) throw new Error("INVALID_BUSINESS_ID");
    try {
      const result = await (await getPool()).query(
        `SELECT business_id, source_kind, campaign_code, acquisition_plan_key,
                source_channel, campaign_name, attributed_at, created_at
           FROM growthwise_acquisition_attribution
          WHERE business_id = $1`,
        [id],
      );
      return result.rows[0] ?? null;
    } catch (error) {
      throw new Error("ACQUISITION_ATTRIBUTION_READ_FAILED", { cause: error });
    }
  }

  return { recordAcquisition, readAcquisition };
}
