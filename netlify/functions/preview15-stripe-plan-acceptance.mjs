import { getDatabase } from "@netlify/database";
import { json } from "./_lead-store.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { resolveSubscriptionEntitlements } from "./_entitlements.mjs";
import { createStripeClient } from "./_stripe-client.mjs";
import { generateTenantCredentials } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const EXPECTED_ACCOUNT_ID = "acct_1UICQv41OQl1gXUm";
const PREVIEW_ORIGIN = "https://deploy-preview-15--euphonious-beijinho-db4b4d.netlify.app";
const EXPECTED_WEBHOOK_ID = "we_1UIRDb41OQl1gXUmVhrwXrQk";
const EXPECTED_WEBHOOK_URL = `${PREVIEW_ORIGIN}/.netlify/functions/stripe-webhook`;

function isPreview15(request) {
  try {
    const host = new URL(request.url).hostname;
    return host.startsWith("deploy-preview-15--") && host.endsWith(".netlify.app");
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(read, predicate, attempts = 8, delayMs = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const value = await read();
    if (predicate(value)) return value;
    await sleep(delayMs);
  }
  return null;
}

async function cleanupDatabase(businessId) {
  if (!businessId) return;
  const client = await getDatabase().pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM growthwise_acquisition_attribution WHERE business_id = $1", [businessId]);
    await client.query("DELETE FROM stripe_webhook_events WHERE business_id = $1", [businessId]);
    await client.query("DELETE FROM growthwise_subscriptions WHERE business_id = $1", [businessId]);
    await client.query("DELETE FROM growthwise_tenants WHERE business_id = $1", [businessId]);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

export default async function handler(request) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!isPreview15(request)) return json(404, { error: "Not found" });

  const secretKey = Netlify.env.get("STRIPE_SECRET_KEY") || "";
  const growthPriceId = Netlify.env.get("STRIPE_GROWTH_PRICE_ID") || "";
  const proPriceId = Netlify.env.get("STRIPE_PRO_PRICE_ID") || "";
  const portalConfigurationId = Netlify.env.get("STRIPE_PORTAL_CONFIGURATION_ID") || "";

  let stripe;
  try {
    stripe = createStripeClient({ secretKey });
  } catch {
    return json(503, { ok: false, error: "Stripe unavailable" });
  }

  let businessId = "";
  let customerId = "";
  let subscriptionId = "";
  let cleanup = { subscription_canceled: false, customer_deleted: false, database_cleaned: false };

  try {
    const [account, growthPrice, proPrice, webhook, portalConfig] = await Promise.all([
      stripe.accounts.retrieve(),
      growthPriceId ? stripe.prices.retrieve(growthPriceId) : null,
      proPriceId ? stripe.prices.retrieve(proPriceId) : null,
      stripe.webhookEndpoints.retrieve(EXPECTED_WEBHOOK_ID),
      portalConfigurationId ? stripe.billingPortal.configurations.retrieve(portalConfigurationId) : null,
    ]);

    if (
      account?.id !== EXPECTED_ACCOUNT_ID ||
      !growthPrice || growthPrice.livemode !== false || growthPrice.unit_amount !== 19900 ||
      !proPrice || proPrice.livemode !== false || proPrice.unit_amount !== 39900 ||
      webhook?.id !== EXPECTED_WEBHOOK_ID || webhook.url !== EXPECTED_WEBHOOK_URL ||
      webhook.status !== "enabled" ||
      !portalConfig || portalConfig.id !== portalConfigurationId || portalConfig.active !== true
    ) {
      return json(409, { ok: false, error: "Preview billing sandbox is not aligned" });
    }

    const tenantCredentials = generateTenantCredentials({ businessName: "Preview 15 Plan Acceptance" });
    businessId = tenantCredentials.businessId;

    await createTenantStore().createTenant({
      businessId,
      businessName: "Preview 15 Plan Acceptance",
      contactName: "GrowthWise QA",
      email: `preview15-plan-${Date.now()}@example.invalid`,
      accessKeyHash: tenantCredentials.accessKeyHash,
    });

    const customer = await stripe.customers.create({
      name: "GrowthWise Preview 15 Plan Acceptance",
      email: `preview15-plan-${Date.now()}@example.invalid`,
      payment_method: "pm_card_visa",
      invoice_settings: { default_payment_method: "pm_card_visa" },
      metadata: {
        business_id: businessId,
        acceptance_test: "preview15_growth_to_pro",
      },
    });
    customerId = customer.id;

    const subscription = await stripe.subscriptions.create({
      customer: customer.id,
      items: [{ price: growthPriceId, quantity: 1 }],
      metadata: {
        business_id: businessId,
        plan_key: "growth_monthly",
        acceptance_test: "preview15_growth_to_pro",
      },
      payment_behavior: "error_if_incomplete",
    });
    subscriptionId = subscription.id;

    const billingStore = createBillingStore();
    const growthRow = await waitFor(
      () => billingStore.readSubscription({ businessId }),
      (row) => row?.plan_key === "growth_monthly"
        && row?.stripe_price_id === growthPriceId
        && ["active", "trialing"].includes(row?.status),
    );

    if (!growthRow) throw new Error("GROWTH_WEBHOOK_SYNC_FAILED");

    const growthStartedAt = new Date(growthRow.plan_started_at);
    if (!Number.isFinite(growthStartedAt.getTime())) throw new Error("GROWTH_PLAN_START_INVALID");

    const growthEntitlements = resolveSubscriptionEntitlements(growthRow);
    const beforeWasProExperience = growthEntitlements.plan_key === "growth_monthly"
      && growthEntitlements.effective_tier === "pro_experience"
      && growthEntitlements.pro_experience?.active === true;

    const stripeGrowth = await stripe.subscriptions.retrieve(subscription.id);
    const item = stripeGrowth.items?.data?.[0];
    if (!item?.id || (typeof item.price === "string" ? item.price : item.price?.id) !== growthPriceId) {
      throw new Error("GROWTH_STRIPE_STATE_INVALID");
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: customer.id,
      configuration: portalConfigurationId,
      return_url: `${PREVIEW_ORIGIN}/app.html?billing=plan-return`,
      flow_data: {
        type: "subscription_update_confirm",
        after_completion: {
          type: "redirect",
          redirect: { return_url: `${PREVIEW_ORIGIN}/app.html?billing=plan-updated` },
        },
        subscription_update_confirm: {
          subscription: subscription.id,
          items: [{ id: item.id, price: proPriceId, quantity: 1 }],
        },
      },
    });

    const portalUrl = new URL(portalSession.url);
    const portalSessionOk = portalUrl.protocol === "https:"
      && portalUrl.hostname === "billing.stripe.com";

    if (!portalSessionOk) throw new Error("PORTAL_SESSION_INVALID");

    await sleep(1100);

    await stripe.subscriptions.update(subscription.id, {
      items: [{ id: item.id, price: proPriceId, quantity: 1 }],
      proration_behavior: "none",
    });

    const proRow = await waitFor(
      () => billingStore.readSubscription({ businessId }),
      (row) => row?.plan_key === "pro_monthly"
        && row?.stripe_price_id === proPriceId
        && ["active", "trialing"].includes(row?.status),
    );

    if (!proRow) throw new Error("PRO_WEBHOOK_SYNC_FAILED");

    const proStartedAt = new Date(proRow.plan_started_at);
    if (!Number.isFinite(proStartedAt.getTime())) throw new Error("PRO_PLAN_START_INVALID");

    const stripePro = await stripe.subscriptions.retrieve(subscription.id);
    const stripeProPriceId = typeof stripePro.items?.data?.[0]?.price === "string"
      ? stripePro.items.data[0].price
      : stripePro.items?.data?.[0]?.price?.id || null;

    const metadataStayedGrowth = stripePro.metadata?.plan_key === "growth_monthly";
    const proEntitlements = resolveSubscriptionEntitlements(proRow);
    const allProFeatures = proEntitlements.access_granted === true
      && proEntitlements.plan_key === "pro_monthly"
      && proEntitlements.effective_tier === "pro"
      && Object.values(proEntitlements.feature_access || {}).every(Boolean);

    const planStartedReset = proStartedAt.getTime() > growthStartedAt.getTime();

    const result = {
      ok: portalSessionOk
        && beforeWasProExperience
        && metadataStayedGrowth
        && stripeProPriceId === proPriceId
        && planStartedReset
        && allProFeatures,
      sandbox_account_verified: true,
      portal_plan_change_session_created: portalSessionOk,
      growth_webhook_synced: true,
      growth_effective_tier: growthEntitlements.effective_tier,
      stripe_metadata_intentionally_stale: metadataStayedGrowth,
      stripe_price_changed_to_pro: stripeProPriceId === proPriceId,
      growthwise_plan_changed_to_pro: proRow.plan_key === "pro_monthly",
      plan_started_at_reset: planStartedReset,
      pro_entitlements_active: allProFeatures,
      production_touched: false,
    };

    await stripe.subscriptions.cancel(subscription.id);
    cleanup.subscription_canceled = true;

    await waitFor(
      () => billingStore.readSubscription({ businessId }),
      (row) => row?.status === "canceled",
      6,
      150,
    );

    await stripe.customers.del(customer.id);
    cleanup.customer_deleted = true;

    await cleanupDatabase(businessId);
    cleanup.database_cleaned = true;

    const remaining = await billingStore.readSubscription({ businessId });
    result.cleanup = {
      ...cleanup,
      persisted_subscription_row: remaining !== null,
    };

    return json(result.ok && !remaining ? 200 : 503, result);
  } catch (error) {
    try {
      if (subscriptionId && !cleanup.subscription_canceled) {
        await stripe.subscriptions.cancel(subscriptionId);
        cleanup.subscription_canceled = true;
      }
    } catch {}
    try {
      if (customerId && !cleanup.customer_deleted) {
        await stripe.customers.del(customerId);
        cleanup.customer_deleted = true;
      }
    } catch {}
    try {
      if (businessId && !cleanup.database_cleaned) {
        await cleanupDatabase(businessId);
        cleanup.database_cleaned = true;
      }
    } catch {}

    return json(503, {
      ok: false,
      error: typeof error?.message === "string" ? error.message : "Preview plan acceptance failed",
      cleanup,
      production_touched: false,
    });
  }
}
