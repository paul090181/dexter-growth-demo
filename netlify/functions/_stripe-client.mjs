import Stripe from "stripe";

export function createStripeClient({ secretKey }) {
  if (!String(secretKey || "").startsWith("sk_")) {
    throw new Error("STRIPE_SECRET_KEY_REQUIRED");
  }
  return new Stripe(secretKey, { apiVersion: "2025-06-30.basil" });
}

export async function createCheckoutSession(stripe, {
  priceId,
  businessId,
  origin,
  planKey = "founding_monthly",
}) {
  const metadata = { business_id: businessId, plan_key: planKey };
  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${origin}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/?billing=cancelled`,
  });
}
