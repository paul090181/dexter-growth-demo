import { DEFAULT_BILLING_TENANTS, billingTenantsFromEnvironment } from "./_billing-tenants.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { authorized as defaultAuthorized, json } from "./_lead-store.mjs";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { resolveSubscriptionEntitlements } from "./_entitlements.mjs";


function publicSubscription(businessId, row, now = new Date()) {
  const entitlements = resolveSubscriptionEntitlements(row, { now });
  return {
    business_id: businessId,
    access_source: row?.access_source ?? null,
    plan_key: row?.plan_key ?? null,
    status: row?.status ?? "not_subscribed",
    current_period_end: row?.current_period_end ?? null,
    access_granted: entitlements.access_granted,
    plan_tier: entitlements.plan_tier,
    effective_tier: entitlements.effective_tier,
    plan_name: entitlements.plan_name,
    monthly_price_usd: entitlements.monthly_price_usd,
    entitlements: entitlements.entitlements,
    feature_access: entitlements.feature_access,
    pro_experience: entitlements.pro_experience,
  };
}

export function createSubscriptionStatusHandler({
  authorized = defaultAuthorized,
  store,
  tenants = DEFAULT_BILLING_TENANTS,
  tenantStore,
  now = () => new Date(),
}) {
  return async function subscriptionStatusHandler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed" });
    const businessId = new URL(request.url).searchParams.get("business_id")?.trim() || "";
    const adminAuth = authorized(request);
    if (adminAuth.ok) {
      if (!tenants.has(businessId)) return json(404, { error: "Business not found." });
    } else {
      const tenantAuth = await authorizeTenantRequest(request, { businessId, store: tenantStore });
      if (!tenantAuth.ok) return json(401, { error: "Unauthorized" });
    }

    try {
      const row = await store.readSubscription({ businessId });
      return json(200, publicSubscription(businessId, row, now()));
    } catch {
      return json(503, { error: "Subscription status unavailable." });
    }
  };
}

export default function handler(request) {
  const tenants = billingTenantsFromEnvironment(Netlify.env.get("GROWTHWISE_BILLING_TENANTS") || "");
  return createSubscriptionStatusHandler({
    store: createBillingStore(),
    tenantStore: createTenantStore(),
    tenants,
  })(request);
}
