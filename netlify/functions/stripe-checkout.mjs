import { authorized as defaultAuthorized, json } from "./_lead-store.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { DEFAULT_BILLING_TENANTS, billingTenantsFromEnvironment } from "./_billing-tenants.mjs";
import { createCheckoutSession, createStripeClient } from "./_stripe-client.mjs";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { resolveStripePlanPrice, stripePlanPricesFromEnvironment } from "./_stripe-plans.mjs";

const MAX_BODY_BYTES = 16_384;

function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function approvedCheckoutUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  } catch {
    return false;
  }
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

export function createStripeCheckoutHandler({
  authorized = defaultAuthorized,
  stripe,
  priceIds,
  origin,
  tenants = DEFAULT_BILLING_TENANTS,
  tenantStore,
  billingStore,
}) {
  return async function stripeCheckoutHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!stripe || !validOrigin(origin)) {
      return json(503, { error: "Billing is not configured." });
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, { error: error.status === 413 ? "Request too large." : "Invalid JSON." });
    }

    const businessId = String(body?.business_id || "").trim();
    const requestedPlanKey = String(body?.plan_key || "founding_monthly").trim();
    const plan = resolveStripePlanPrice(priceIds, requestedPlanKey);
    if (!plan.ok) {
      return json(plan.code === "UNKNOWN_PLAN" ? 400 : 503, {
        error: plan.code === "UNKNOWN_PLAN" ? "Plan is not available." : "Selected plan is not configured.",
      });
    }
    const adminAuth = authorized(request);
    let auth = adminAuth;
    if (adminAuth.ok) {
      if (!tenants.has(businessId)) return json(404, { error: "Business not found." });
    } else {
      auth = await authorizeTenantRequest(request, { businessId, store: tenantStore });
      if (!auth.ok) return json(401, { error: "Unauthorized" });
    }

    try {
      const subscription = await billingStore.readSubscription({ businessId });
      if (subscription?.stripe_subscription_id) {
        return json(409, { error: "A Stripe subscription is already linked to this business." });
      }
    } catch {
      return json(503, { error: "Subscription status unavailable." });
    }

    try {
      const session = await createCheckoutSession(stripe, {
        priceId: plan.priceId,
        businessId,
        origin,
        planKey: plan.planKey,
        returnPath: auth.via === "tenant" ? "/signup.html" : "/",
      });
      if (!approvedCheckoutUrl(session?.url)) {
        return json(502, { error: "Checkout session unavailable." });
      }
      return json(200, { checkout_url: session.url });
    } catch {
      return json(502, { error: "Checkout session unavailable." });
    }
  };
}

function environment() {
  return {
    secretKey: Netlify.env.get("STRIPE_SECRET_KEY") || "",
    priceIds: stripePlanPricesFromEnvironment(),
    origin: resolveGrowthWisePublicOrigin(),
    tenants: billingTenantsFromEnvironment(Netlify.env.get("GROWTHWISE_BILLING_TENANTS") || ""),
  };
}

export default async function handler(request) {
  const config = environment();
  let stripe;
  try {
    stripe = createStripeClient({ secretKey: config.secretKey });
  } catch {
    return json(503, { error: "Billing is not configured." });
  }
  return createStripeCheckoutHandler({
    stripe,
    tenantStore: createTenantStore(),
    billingStore: createBillingStore(),
    ...config,
  })(request);
}
