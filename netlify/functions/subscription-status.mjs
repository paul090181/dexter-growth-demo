import { DEFAULT_BILLING_TENANTS, billingTenantsFromEnvironment } from "./_billing-tenants.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { authorized as defaultAuthorized, json } from "./_lead-store.mjs";

function publicSubscription(businessId, row) {
  return {
    business_id: businessId,
    access_source: row?.access_source ?? null,
    plan_key: row?.plan_key ?? null,
    status: row?.status ?? "not_subscribed",
    current_period_end: row?.current_period_end ?? null,
  };
}

export function createSubscriptionStatusHandler({
  authorized = defaultAuthorized,
  store,
  tenants = DEFAULT_BILLING_TENANTS,
}) {
  return async function subscriptionStatusHandler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed" });
    if (!authorized(request).ok) return json(401, { error: "Unauthorized" });

    const businessId = new URL(request.url).searchParams.get("business_id")?.trim() || "";
    if (!tenants.has(businessId)) return json(404, { error: "Business not found." });

    try {
      const row = await store.readSubscription({ businessId });
      return json(200, publicSubscription(businessId, row));
    } catch {
      return json(503, { error: "Subscription status unavailable." });
    }
  };
}

export default function handler(request) {
  const tenants = billingTenantsFromEnvironment(Netlify.env.get("GROWTHWISE_BILLING_TENANTS") || "");
  return createSubscriptionStatusHandler({ store: createBillingStore(), tenants })(request);
}
