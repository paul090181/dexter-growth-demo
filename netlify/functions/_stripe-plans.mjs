const PLAN_ENV = Object.freeze({
  founding_monthly: "STRIPE_PRICE_ID",
  starter_monthly: "STRIPE_STARTER_PRICE_ID",
  growth_monthly: "STRIPE_GROWTH_PRICE_ID",
  pro_monthly: "STRIPE_PRO_PRICE_ID",
});

export const CHANGEABLE_PLAN_KEYS = Object.freeze([
  "starter_monthly",
  "growth_monthly",
  "pro_monthly",
]);

export function stripePlanPricesFromEnvironment(get = (name) => Netlify.env.get(name) || "") {
  return Object.fromEntries(
    Object.entries(PLAN_ENV).map(([planKey, envName]) => [planKey, String(get(envName) || "").trim()]),
  );
}

export function resolveStripePlanPrice(priceIds, planKey) {
  const key = typeof planKey === "string" && planKey.trim() ? planKey.trim() : "founding_monthly";
  if (!Object.hasOwn(PLAN_ENV, key)) return { ok: false, code: "UNKNOWN_PLAN", planKey: key, priceId: "" };
  const priceId = String(priceIds?.[key] || "").trim();
  if (!/^price_[A-Za-z0-9]+$/.test(priceId)) {
    return { ok: false, code: "PLAN_NOT_CONFIGURED", planKey: key, priceId: "" };
  }
  return { ok: true, code: "OK", planKey: key, priceId };
}

export function canSelfServePlanChange(currentPlanKey, targetPlanKey) {
  if (!CHANGEABLE_PLAN_KEYS.includes(currentPlanKey)) return false;
  if (!CHANGEABLE_PLAN_KEYS.includes(targetPlanKey)) return false;
  return currentPlanKey !== targetPlanKey;
}
