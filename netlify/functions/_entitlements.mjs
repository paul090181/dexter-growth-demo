export const CUSTOMER_FEATURES = Object.freeze([
  "ai_business_assistant",
  "lead_reply_drafting",
  "promotion_content",
  "inventory_connection",
  "unified_inbox",
  "automated_publishing",
  "orders_restock",
  "business_insights",
  "multi_channel_automation",
  "advanced_ai_automation",
  "multi_location",
]);

const STARTER_FEATURES = Object.freeze([
  "ai_business_assistant",
  "lead_reply_drafting",
  "promotion_content",
  "business_insights",
]);

const GROWTH_FEATURES = Object.freeze([
  ...STARTER_FEATURES,
  "inventory_connection",
  "unified_inbox",
  "automated_publishing",
  "orders_restock",
]);

const PRO_FEATURES = CUSTOMER_FEATURES;

export const PLAN_CATALOG = Object.freeze({
  founding_monthly: Object.freeze({
    key: "founding_monthly",
    tier: "founding",
    display_name: "Founding Member",
    monthly_price_usd: 49,
    features: PRO_FEATURES,
  }),
  starter_monthly: Object.freeze({
    key: "starter_monthly",
    tier: "starter",
    display_name: "Starter",
    monthly_price_usd: 99,
    features: STARTER_FEATURES,
  }),
  growth_monthly: Object.freeze({
    key: "growth_monthly",
    tier: "growth",
    display_name: "Growth",
    monthly_price_usd: 199,
    features: GROWTH_FEATURES,
    pro_experience_days: 30,
  }),
  pro_monthly: Object.freeze({
    key: "pro_monthly",
    tier: "pro",
    display_name: "Pro",
    monthly_price_usd: 399,
    features: PRO_FEATURES,
  }),
});

const STRIPE_ACCESS_STATUSES = new Set(["active", "trialing"]);

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function iso(value) {
  const date = validDate(value);
  return date ? date.toISOString() : null;
}

export function resolveSubscriptionEntitlements(subscription, { now = new Date() } = {}) {
  const planKey = typeof subscription?.plan_key === "string" ? subscription.plan_key : "";
  const plan = PLAN_CATALOG[planKey] || null;
  const accessSource = subscription?.access_source ?? null;
  const status = subscription?.status ?? "not_subscribed";
  const accessGranted = accessSource === "pilot"
    || (accessSource === "stripe" && STRIPE_ACCESS_STATUSES.has(status));

  const base = {
    plan_key: planKey || null,
    plan_tier: plan?.tier ?? null,
    effective_tier: plan?.tier ?? null,
    plan_name: plan?.display_name ?? null,
    monthly_price_usd: plan?.monthly_price_usd ?? null,
    access_granted: accessGranted,
    entitlements: [],
    feature_access: Object.fromEntries(CUSTOMER_FEATURES.map((feature) => [feature, false])),
    pro_experience: {
      eligible: planKey === "growth_monthly",
      active: false,
      starts_at: null,
      ends_at: null,
      remaining_days: 0,
      converts_automatically: false,
      fallback_plan_key: planKey === "growth_monthly" ? "growth_monthly" : null,
    },
  };

  if (!plan || !accessGranted) return base;

  let features = [...plan.features];
  let effectiveTier = plan.tier;
  let proExperience = base.pro_experience;

  if (planKey === "growth_monthly") {
    const startedAt = validDate(subscription?.plan_started_at ?? subscription?.created_at);
    const nowDate = validDate(now) || new Date();
    if (startedAt) {
      const endsAt = new Date(startedAt.getTime() + plan.pro_experience_days * 24 * 60 * 60 * 1000);
      const active = nowDate.getTime() < endsAt.getTime();
      const remainingMs = Math.max(0, endsAt.getTime() - nowDate.getTime());
      proExperience = {
        eligible: true,
        active,
        starts_at: startedAt.toISOString(),
        ends_at: endsAt.toISOString(),
        remaining_days: active ? Math.max(1, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))) : 0,
        converts_automatically: false,
        fallback_plan_key: "growth_monthly",
      };
      if (active) {
        features = [...PRO_FEATURES];
        effectiveTier = "pro_experience";
      }
    }
  }

  const uniqueFeatures = [...new Set(features)];
  return {
    ...base,
    effective_tier: effectiveTier,
    entitlements: uniqueFeatures,
    feature_access: Object.fromEntries(
      CUSTOMER_FEATURES.map((feature) => [feature, uniqueFeatures.includes(feature)]),
    ),
    pro_experience: proExperience,
  };
}

export function hasEntitlement(snapshot, feature) {
  return snapshot?.access_granted === true && snapshot?.feature_access?.[feature] === true;
}
