import { json } from "./_lead-store.mjs";
import { createStripeClient } from "./_stripe-client.mjs";

function isPreview15(request) {
  try {
    const host = new URL(request.url).hostname;
    return host.startsWith("deploy-preview-15--") && host.endsWith(".netlify.app");
  } catch {
    return false;
  }
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
    const [account, foundingPrice, endpoints, prices] = await Promise.all([
      stripe.accounts.retrieve(),
      foundingPriceId ? stripe.prices.retrieve(foundingPriceId) : null,
      stripe.webhookEndpoints.list({ limit: 100 }),
      stripe.prices.list({ active: true, type: "recurring", limit: 100 }),
    ]);

    const recurringPrices = (prices?.data || []).map((price) => ({
      id: price.id,
      livemode: price.livemode === true,
      unit_amount: price.unit_amount,
      currency: price.currency,
      interval: price.recurring?.interval || null,
      product: typeof price.product === "string" ? price.product : price.product?.id || null,
      lookup_key: price.lookup_key || null,
      metadata: price.metadata || {},
    }));

    return json(200, {
      ok: true,
      account_id: account?.id || null,
      country: account?.country || null,
      founding_price: foundingPrice ? {
        id: foundingPrice.id,
        livemode: foundingPrice.livemode === true,
        unit_amount: foundingPrice.unit_amount,
        currency: foundingPrice.currency,
        metadata: foundingPrice.metadata || {},
      } : null,
      webhook_endpoints: (endpoints?.data || []).map((endpoint) => ({
        id: endpoint.id,
        url: endpoint.url,
        status: endpoint.status,
        enabled_events: endpoint.enabled_events,
      })),
      recurring_prices: recurringPrices,
    });
  } catch {
    return json(503, { ok: false, error: "Stripe inspection failed" });
  }
}
