import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createOnboardingAnalyticsStore, ALLOWED_EVENTS } from "./_onboarding-analytics-store.mjs";

const MAX_BODY_BYTES = 8_192;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { status: 400 });
  }
}

export function createOnboardingEventHandler({
  tenantStore,
  analyticsStore,
  authorize = authorizeTenantRequest,
  now = () => new Date(),
} = {}) {
  return async function onboardingEventHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, {
        error: error.status === 413 ? "Request too large." : "Invalid JSON.",
      });
    }

    const businessId = typeof body?.business_id === "string" ? body.business_id.trim() : "";
    const eventName = typeof body?.event_name === "string" ? body.event_name.trim() : "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId)
      || businessId.length > 200
      || !ALLOWED_EVENTS.has(eventName)) {
      return json(400, { error: "Invalid onboarding event." });
    }

    const auth = await authorize(request, { businessId, store: tenantStore });
    if (!auth?.ok || auth.businessId !== businessId) {
      return json(401, { error: "Tenant credentials are invalid." });
    }

    try {
      const recorded = await analyticsStore.recordEvent({
        businessId,
        eventName,
        occurredAt: now(),
      });
      return json(200, {
        ok: true,
        event_name: eventName,
        recorded: Boolean(recorded),
      });
    } catch {
      return json(503, { error: "Onboarding analytics are temporarily unavailable." });
    }
  };
}

export default function handler(request) {
  return createOnboardingEventHandler({
    tenantStore: createTenantStore(),
    analyticsStore: createOnboardingAnalyticsStore(),
  })(request);
}
