import Stripe from "stripe";
import { createHash } from "node:crypto";

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
  returnPath = "/",
}) {
  const metadata = { business_id: businessId, plan_key: planKey };
  const idempotencyKey = `growthwise-founding-${createHash("sha256").update(businessId).digest("hex").slice(0, 32)}`;
  return stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${origin}${returnPath}?billing=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}${returnPath}?billing=cancelled`,
  }, { idempotencyKey });
}
