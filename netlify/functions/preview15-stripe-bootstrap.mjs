import { json } from "./_lead-store.mjs";
import { createStripeClient } from "./_stripe-client.mjs";

const EXPECTED_ACCOUNT_ID = "acct_1UICQv41OQl1gXUm";
const EXPECTED_WEBHOOK_ID = "we_1UIRDb41OQl1gXUmVhrwXrQk";
const PREVIEW_ORIGIN = "https://deploy-preview-15--euphonious-beijinho-db4b4d.netlify.app";
const WEBHOOK_URL = `${PREVIEW_ORIGIN}/.netlify/functions/stripe-webhook`;
const EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
];

const PLANS = [
  { plan_key: "starter_monthly", name: "GrowthWise Starter", amount: 9900 },
  { plan_key: "growth_monthly", name: "GrowthWise Growth", amount: 19900 },
  { plan_key: "pro_monthly", name: "GrowthWise Pro", amount: 39900 },
];

function isPreview15(request) {
  try {
    const host = new URL(request.url).hostname;
    return host.startsWith("deploy-preview-15--") && host.endsWith(".netlify.app");
  } catch {
    return false;
  }
}

function productPlanKey(product) {
  return typeof product?.metadata?.plan_key === "string" ? product.metadata.plan_key : "";
}

function pricePlanKey(price) {
  return typeof price?.metadata?.plan_key === "string" ? price.metadata.plan_key : "";
}

async function ensurePlan(stripe, plan, products, prices) {
  let product = products.find((candidate) =>
    productPlanKey(candidate) === plan.plan_key &&
    candidate.metadata?.environment === "preview15_acceptance"
  );
  if (!product) {
    product = await stripe.products.create({
      name: plan.name,
      metadata: {
        environment: "preview15_acceptance",
        plan_key: plan.plan_key,
      },
    });
    products.push(product);
  }

  let price = prices.find((candidate) =>
    pricePlanKey(candidate) === plan.plan_key &&
    candidate.product === product.id &&
    candidate.currency === "usd" &&
    candidate.unit_amount === plan.amount &&
    candidate.recurring?.interval === "month"
  );
  if (!price) {
    price = await stripe.prices.create({
      product: product.id,
      unit_amount: plan.amount,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: {
        environment: "preview15_acceptance",
        plan_key: plan.plan_key,
      },
    });
    prices.push(price);
  }

  return { plan_key: plan.plan_key, product_id: product.id, price_id: price.id };
}

export default async function handler(request) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!isPreview15(request)) return json(404, { error: "Not found" });

  const secretKey = Netlify.env.get("STRIPE_SECRET_KEY") || "";
  const foundingPriceId = Netlify.env.get("STRIPE_PRICE_ID") || "";
  let stripe;
  try {
    stripe = createStripeClient({ secretKey });
  } catch {
    return json(503, { ok: false, error: "Stripe unavailable" });
  }

  try {
    const [account, foundingPrice, webhook, productList, priceList, portalList] = await Promise.all([
      stripe.accounts.retrieve(),
      foundingPriceId ? stripe.prices.retrieve(foundingPriceId) : null,
      stripe.webhookEndpoints.retrieve(EXPECTED_WEBHOOK_ID),
      stripe.products.list({ active: true, limit: 100 }),
      stripe.prices.list({ active: true, type: "recurring", limit: 100 }),
      stripe.billingPortal.configurations.list({ active: true, limit: 100 }),
    ]);

    if (
      account?.id !== EXPECTED_ACCOUNT_ID ||
      !foundingPrice ||
      foundingPrice.livemode !== false ||
      foundingPrice.id !== foundingPriceId ||
      foundingPrice.unit_amount !== 4900 ||
      foundingPrice.currency !== "usd" ||
      webhook?.id !== EXPECTED_WEBHOOK_ID
    ) {
      return json(409, { ok: false, error: "Unexpected Stripe sandbox binding" });
    }

    const products = [...(productList?.data || [])];
    const prices = [...(priceList?.data || [])];
    const ensured = [];
    for (const plan of PLANS) ensured.push(await ensurePlan(stripe, plan, products, prices));

    const portalProducts = ensured.map((plan) => ({
      product: plan.product_id,
      prices: [plan.price_id],
    }));

    let portal = (portalList?.data || []).find((candidate) =>
      candidate.metadata?.growthwise_config === "preview15_plan_change"
    );

    const portalFeatures = {
      payment_method_update: { enabled: true },
      invoice_history: { enabled: true },
      subscription_cancel: { enabled: true, mode: "at_period_end" },
      subscription_update: {
        enabled: true,
        default_allowed_updates: ["price"],
        proration_behavior: "create_prorations",
        products: portalProducts,
      },
    };

    if (portal) {
      portal = await stripe.billingPortal.configurations.update(portal.id, {
        business_profile: { headline: "GrowthWise billing" },
        features: portalFeatures,
        metadata: { growthwise_config: "preview15_plan_change" },
      });
    } else {
      portal = await stripe.billingPortal.configurations.create({
        business_profile: { headline: "GrowthWise billing" },
        features: portalFeatures,
        metadata: { growthwise_config: "preview15_plan_change" },
        name: "GrowthWise Preview 15 plan changes",
      });
    }

    const updatedWebhook = await stripe.webhookEndpoints.update(EXPECTED_WEBHOOK_ID, {
      url: WEBHOOK_URL,
      enabled_events: EVENTS,
    });

    return json(200, {
      ok: true,
      account_id: account.id,
      livemode: false,
      founding_price_id: foundingPrice.id,
      starter_price_id: ensured.find((p) => p.plan_key === "starter_monthly")?.price_id || null,
      growth_price_id: ensured.find((p) => p.plan_key === "growth_monthly")?.price_id || null,
      pro_price_id: ensured.find((p) => p.plan_key === "pro_monthly")?.price_id || null,
      portal_configuration_id: portal?.id || null,
      webhook: {
        id: updatedWebhook?.id || null,
        url: updatedWebhook?.url || null,
        status: updatedWebhook?.status || null,
      },
    });
  } catch {
    return json(503, { ok: false, error: "Stripe sandbox bootstrap failed" });
  }
}
