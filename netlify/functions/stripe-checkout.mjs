import { authorized as defaultAuthorized, json } from "./_lead-store.mjs";
import { DEFAULT_BILLING_TENANTS, billingTenantsFromEnvironment } from "./_billing-tenants.mjs";
import { createCheckoutSession, createStripeClient } from "./_stripe-client.mjs";

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
  priceId,
  origin,
  tenants = DEFAULT_BILLING_TENANTS,
}) {
  return async function stripeCheckoutHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!authorized(request).ok) return json(401, { error: "Unauthorized" });
    if (!stripe || !priceId || !validOrigin(origin)) {
      return json(503, { error: "Billing is not configured." });
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, { error: error.status === 413 ? "Request too large." : "Invalid JSON." });
    }

    const businessId = String(body?.business_id || "").trim();
    if (!tenants.has(businessId)) return json(404, { error: "Business not found." });

    try {
      const session = await createCheckoutSession(stripe, { priceId, businessId, origin });
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
    priceId: Netlify.env.get("STRIPE_PRICE_ID") || "",
    origin: Netlify.env.get("GROWTHWISE_PUBLIC_ORIGIN") || "",
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
  return createStripeCheckoutHandler({ stripe, ...config })(request);
}
