import { json } from "./_lead-store.mjs";
import { createBillingService } from "./_billing-service.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { createStripeClient } from "./_stripe-client.mjs";

const MAX_WEBHOOK_BYTES = 256_000;

async function readLimitedText(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_WEBHOOK_BYTES) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > MAX_WEBHOOK_BYTES) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  return new TextDecoder().decode(buffer);
}

export function createStripeWebhookHandler({
  constructEvent,
  billingService,
  webhookSecret,
  logger = console,
}) {
  return async function stripeWebhookHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    if (!webhookSecret || typeof constructEvent !== "function" || !billingService?.processEvent) {
      return json(503, { error: "Billing webhook is not configured." });
    }

    const signature = request.headers.get("stripe-signature") || "";
    if (!signature) return json(400, { error: "Invalid webhook signature." });

    let rawBody;
    try {
      rawBody = await readLimitedText(request);
    } catch (error) {
      return json(error.status === 413 ? 413 : 400, {
        error: error.status === 413 ? "Request too large." : "Invalid webhook body.",
      });
    }

    let event;
    try {
      event = constructEvent(rawBody, signature, webhookSecret);
    } catch {
      return json(400, { error: "Invalid webhook signature." });
    }

    try {
      const result = await billingService.processEvent(event);
      return json(200, { received: true, outcome: result.outcome });
    } catch {
      logger.error("stripe_webhook_failed", {
        event_id: typeof event?.id === "string" ? event.id : null,
        event_type: typeof event?.type === "string" ? event.type : null,
        code: "WEBHOOK_PROCESSING_FAILED",
      });
      return json(500, { error: "Webhook processing failed." });
    }
  };
}

export default async function handler(request) {
  const secretKey = Netlify.env.get("STRIPE_SECRET_KEY") || "";
  const webhookSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET") || "";
  let stripe;
  try {
    stripe = createStripeClient({ secretKey });
  } catch {
    return json(503, { error: "Billing webhook is not configured." });
  }
  const billingService = createBillingService({ store: createBillingStore() });
  return createStripeWebhookHandler({
    constructEvent: stripe.webhooks.constructEvent.bind(stripe.webhooks),
    billingService,
    webhookSecret,
  })(request);
}
