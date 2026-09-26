import { createBillingStore } from "./_billing-store.mjs";
import { authorized } from "./_lead-store.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function cleanBusinessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return clean && clean.length <= 80 ? clean : "";
}

function previewPilotAccessEnabled() {
  return Netlify.env.get("GROWTHWISE_PILOT_ACCESS_ENABLED") === "true";
}

export function createPilotAccessGrantHandler({
  isAuthorized = authorized,
  isEnabled = previewPilotAccessEnabled,
  billingStore = createBillingStore(),
  tenantStore = createTenantStore(),
  now = () => new Date(),
} = {}) {
  return async function pilotAccessGrant(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (!isAuthorized(request)?.ok) return json(401, { error: "Unauthorized." });
    if (!isEnabled()) return json(404, { error: "Pilot access is not enabled." });

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid request." }); }

    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || !Object.hasOwn(body, "business_id")) {
      return json(400, { error: "A valid business_id is required." });
    }

    const businessId = cleanBusinessId(body.business_id);
    if (!businessId) return json(400, { error: "A valid business_id is required." });

    let tenant;
    try {
      tenant = await tenantStore.readTenantProfile({ businessId });
    } catch {
      return json(503, { error: "Pilot access is temporarily unavailable." });
    }
    if (!tenant) return json(404, { error: "Workspace not found." });

    try {
      const subscription = await billingStore.grantPilotAccess({
        businessId,
        planKey: "founding_monthly",
        startedAt: now(),
      });
      return json(200, {
        ok: true,
        business_id: subscription.business_id,
        access_source: subscription.access_source,
        plan_key: subscription.plan_key,
        status: subscription.status,
      });
    } catch (error) {
      if (error?.message === "PILOT_ACCESS_NOT_GRANTED") {
        return json(409, { error: "This workspace already has Stripe-managed billing." });
      }
      return json(503, { error: "Pilot access is temporarily unavailable." });
    }
  };
}

export default function handler(request) {
  return createPilotAccessGrantHandler()(request);
}
