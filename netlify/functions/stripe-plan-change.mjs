import { json } from "./_lead-store.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { createStripeClient } from "./_stripe-client.mjs";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import {
  canSelfServePlanChange,
  resolveStripePlanPrice,
  stripePlanPricesFromEnvironment,
} from "./_stripe-plans.mjs";

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

function validPortalConfiguration(value) {
  return /^bpc_[A-Za-z0-9]+$/.test(String(value || ""));
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

export function createStripePlanChangeHandler({
  stripe,
  priceIds,
  portalConfigurationId,
  origin,
  tenantStore,
  billingStore,
}) {
  return async function stripePlanChangeHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!stripe?.subscriptions?.retrieve
      || !stripe?.billingPortal?.sessions?.create
      || !validOrigin(origin)
      || !validPortalConfiguration(portalConfigurationId)) {
      return json(503, { error: "Plan changes are not configured." });
    }

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, {
        error: error.status === 413 ? "Request too large." : "Invalid JSON.",
      });
    }

    const businessId = String(body?.business_id || "").trim();
    const targetPlanKey = String(body?.plan_key || "").trim();
    if (!businessId || !targetPlanKey) return json(400, { error: "Business and target plan are required." });

    const auth = await authorizeTenantRequest(request, { businessId, store: tenantStore });
    if (!auth.ok) return json(401, { error: "Unauthorized" });

    const target = resolveStripePlanPrice(priceIds, targetPlanKey);
    if (!target.ok || !["starter_monthly", "growth_monthly", "pro_monthly"].includes(target.planKey)) {
      return json(target.code === "PLAN_NOT_CONFIGURED" ? 503 : 400, {
        error: target.code === "PLAN_NOT_CONFIGURED"
          ? "Selected plan is not configured."
          : "Selected plan is not available for self-service changes.",
      });
    }

    let subscription;
    try {
      subscription = await billingStore.readSubscription({ businessId });
    } catch {
      return json(503, { error: "Billing status unavailable." });
    }

    if (subscription?.access_source !== "stripe"
      || !subscription?.stripe_customer_id
      || !subscription?.stripe_subscription_id) {
      return json(409, { error: "No Stripe subscription is linked to this business." });
    }

    if (!canSelfServePlanChange(subscription.plan_key, target.planKey)) {
      return json(409, {
        error: subscription.plan_key === target.planKey
          ? "This business is already on that plan."
          : "This plan change is not available through self-service.",
      });
    }

    if (!["active", "trialing"].includes(subscription.status)) {
      return json(409, { error: "Resolve the current billing issue before changing plans." });
    }

    try {
      const stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
      if (stripeSubscription?.customer !== subscription.stripe_customer_id) {
        return json(409, { error: "Stripe subscription binding could not be verified." });
      }
      const items = stripeSubscription?.items?.data;
      if (!Array.isArray(items) || items.length !== 1 || !items[0]?.id) {
        return json(409, { error: "This subscription cannot be changed through the simple plan flow." });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: subscription.stripe_customer_id,
        configuration: portalConfigurationId,
        return_url: `${origin}/app.html?billing=plan-return`,
        flow_data: {
          type: "subscription_update_confirm",
          after_completion: {
            type: "redirect",
            redirect: { return_url: `${origin}/app.html?billing=plan-updated` },
          },
          subscription_update_confirm: {
            subscription: subscription.stripe_subscription_id,
            items: [{ id: items[0].id, price: target.priceId, quantity: 1 }],
          },
        },
      });

      if (!approvedPortalUrl(session?.url)) {
        return json(502, { error: "Plan change session unavailable." });
      }

      return json(200, {
        portal_url: session.url,
        target_plan_key: target.planKey,
      });
    } catch {
      return json(502, { error: "Plan change session unavailable." });
    }
  };
}

function environment() {
  return {
    secretKey: Netlify.env.get("STRIPE_SECRET_KEY") || "",
    priceIds: stripePlanPricesFromEnvironment(),
    portalConfigurationId: Netlify.env.get("STRIPE_PORTAL_CONFIGURATION_ID") || "",
    origin: resolveGrowthWisePublicOrigin(),
  };
}

export default async function handler(request) {
  const config = environment();
  let stripe;
  try {
    stripe = createStripeClient({ secretKey: config.secretKey });
  } catch {
    return json(503, { error: "Plan changes are not configured." });
  }

  return createStripePlanChangeHandler({
    stripe,
    tenantStore: createTenantStore(),
    billingStore: createBillingStore(),
    ...config,
  })(request);
}
