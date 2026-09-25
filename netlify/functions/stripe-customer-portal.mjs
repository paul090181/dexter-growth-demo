import { json } from "./_lead-store.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { createStripeClient } from "./_stripe-client.mjs";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const MAX_BODY_BYTES = 16_384;

function validOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
}

function approvedPortalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "billing.stripe.com";
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

export function createStripeCustomerPortalHandler({
  stripe,
  origin,
  tenantStore,
  billingStore,
}) {
  return async function stripeCustomerPortalHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!stripe?.billingPortal?.sessions?.create || !validOrigin(origin)) {
      return json(503, { error: "Billing management is not configured." });
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, { error: error.status === 413 ? "Request too large." : "Invalid JSON." });
    }

    const businessId = String(body?.business_id || "").trim();
    if (!businessId) return json(400, { error: "Business is required." });

    const auth = await authorizeTenantRequest(request, { businessId, store: tenantStore });
    if (!auth.ok) return json(401, { error: "Unauthorized" });

    let subscription;
    try {
      subscription = await billingStore.readSubscription({ businessId });
    } catch {
      return json(503, { error: "Billing status unavailable." });
    }

    if (subscription?.access_source !== "stripe" || !subscription?.stripe_customer_id) {
      return json(409, { error: "No Stripe billing account is linked to this business." });
    }

    try {
      const session = await stripe.billingPortal.sessions.create({
        customer: subscription.stripe_customer_id,
        return_url: `${origin}/signup.html?billing=manage-return`,
      });
      if (!approvedPortalUrl(session?.url)) {
        return json(502, { error: "Billing management session unavailable." });
      }
      return json(200, { portal_url: session.url });
    } catch {
      return json(502, { error: "Billing management session unavailable." });
    }
  };
}

function environment() {
  return {
    secretKey: Netlify.env.get("STRIPE_SECRET_KEY") || "",
    origin: resolveGrowthWisePublicOrigin(),
  };
}

export default async function handler(request) {
  const config = environment();
  let stripe;
  try {
    stripe = createStripeClient({ secretKey: config.secretKey });
  } catch {
    return json(503, { error: "Billing management is not configured." });
  }

  return createStripeCustomerPortalHandler({
    stripe,
    origin: config.origin,
    tenantStore: createTenantStore(),
    billingStore: createBillingStore(),
  })(request);
}
