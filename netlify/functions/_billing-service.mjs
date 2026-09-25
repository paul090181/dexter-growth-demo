export const APPROVED_STRIPE_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
]);

const SUBSCRIPTION_STATUSES = new Set([
  "active", "trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused",
]);

function safeError(code) {
  return new Error(code);
}

function stringId(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object" && typeof value.id === "string" && value.id.trim()) return value.id.trim();
  return null;
}

function metadata(object) {
  return object?.metadata && typeof object.metadata === "object" && !Array.isArray(object.metadata)
    ? object.metadata : {};
}

function unixDate(value) {
  return Number.isInteger(value) && value > 0 ? new Date(value * 1000) : null;
}

function validateEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)
    || typeof event.id !== "string" || !event.id.trim()
    || typeof event.type !== "string" || !event.type.trim()
    || !Number.isInteger(event.created) || event.created <= 0
    || !event.data || typeof event.data !== "object" || Array.isArray(event.data)
    || !event.data.object || typeof event.data.object !== "object" || Array.isArray(event.data.object)) {
    throw safeError("INVALID_STRIPE_EVENT");
  }
  return event;
}

function resultOutcome(result, fallback = "processed") {
  if (result?.duplicate) return "duplicate";
  if (result?.stale) return "stale";
  return fallback;
}

function subscriptionPriceId(object) {
  return stringId(object?.items?.data?.[0]?.price);
}

function planKeyFromPriceId(priceIds, priceId) {
  if (!priceId || !priceIds || typeof priceIds !== "object") return null;
  const matches = Object.entries(priceIds)
    .filter(([, configuredPriceId]) => typeof configuredPriceId === "string"
      && configuredPriceId.trim()
      && configuredPriceId.trim() === priceId)
    .map(([planKey]) => planKey);
  return matches.length === 1 ? matches[0] : null;
}

export function createBillingService({
  store,
  attributionStore = null,
  resolveCheckoutAttribution = null,
  priceIds = null,
} = {}) {
  if (!store?.applyEvent || !store?.readSubscription || !store?.findSubscriptionByStripeIds) {
    throw safeError("BILLING_STORE_REQUIRED");
  }

  async function record(event, normalized, fallbackOutcome = "processed") {
    const result = await store.applyEvent({
      eventId: event.id,
      eventType: event.type,
      eventCreatedAt: new Date(event.created * 1000),
      result: normalized.result ?? "processed",
      ...normalized,
    });
    return {
      outcome: resultOutcome(result, fallbackOutcome),
      businessId: normalized.businessId ?? null,
      subscription: result.subscription ?? null,
    };
  }

  async function processSubscription(event, object) {
    const meta = metadata(object);
    const businessId = typeof meta.business_id === "string" ? meta.business_id.trim() : "";
    const metadataPlanKey = typeof meta.plan_key === "string" ? meta.plan_key.trim() : "";
    const stripeSubscriptionId = stringId(object);
    const stripeCustomerId = stringId(object.customer);
    const stripePriceId = subscriptionPriceId(object);
    const planKey = planKeyFromPriceId(priceIds, stripePriceId) || metadataPlanKey;
    const status = event.type === "customer.subscription.deleted" ? "canceled" : object.status;
    if (!businessId || !planKey || !stripeSubscriptionId || !stripeCustomerId || !SUBSCRIPTION_STATUSES.has(status)) {
      throw safeError("INVALID_SUBSCRIPTION_EVENT");
    }
    return record(event, {
      businessId, planKey, status, stripeCustomerId, stripeSubscriptionId, stripePriceId,
      currentPeriodEnd: unixDate(object.current_period_end),
      advanceLifecycle: true,
    });
  }

  async function processCheckout(event, object) {
    const meta = metadata(object);
    const businessId = typeof meta.business_id === "string" ? meta.business_id.trim() : "";
    const planKey = typeof meta.plan_key === "string" ? meta.plan_key.trim() : "";
    const stripeCustomerId = stringId(object.customer);
    const stripeSubscriptionId = stringId(object.subscription);
    if (!businessId || !planKey || !stripeCustomerId || !stripeSubscriptionId) throw safeError("INVALID_CHECKOUT_EVENT");
    const existing = await store.readSubscription({ businessId });
    const recorded = await record(event, {
      businessId,
      planKey,
      status: existing?.status ?? "incomplete",
      stripeCustomerId,
      stripeSubscriptionId,
      stripePriceId: existing?.stripe_price_id ?? null,
      currentPeriodEnd: existing?.current_period_end ? new Date(existing.current_period_end) : null,
      advanceLifecycle: false,
    });

    if (attributionStore?.recordAcquisition && typeof resolveCheckoutAttribution === "function") {
      const attribution = await resolveCheckoutAttribution({
        checkoutSessionId: stringId(object),
        businessId,
        planKey,
      });
      if (attribution?.campaignCode && attribution?.stripePromotionCodeId) {
        await attributionStore.recordAcquisition({
          businessId,
          campaignCode: attribution.campaignCode,
          stripePromotionCodeId: attribution.stripePromotionCodeId,
          stripeCouponId: attribution.stripeCouponId ?? null,
          stripeCheckoutSessionId: stringId(object),
          acquisitionPlanKey: planKey,
          sourceChannel: attribution.sourceChannel ?? null,
          campaignName: attribution.campaignName ?? null,
          attributedAt: new Date(event.created * 1000),
        });
      }
    }

    return recorded;
  }

  async function processInvoice(event, object) {
    const stripeCustomerId = stringId(object.customer);
    const stripeSubscriptionId = stringId(object.subscription)
      ?? stringId(object.parent?.subscription_details?.subscription);
    if (!stripeCustomerId && !stripeSubscriptionId) throw safeError("TENANT_MAPPING_REQUIRED");
    const existing = await store.findSubscriptionByStripeIds({ stripeCustomerId, stripeSubscriptionId });
    if (!existing) throw safeError("TENANT_MAPPING_REQUIRED");
    return record(event, {
      businessId: existing.business_id,
      planKey: existing.plan_key,
      status: event.type === "invoice.payment_failed" ? "past_due" : existing.status,
      stripeCustomerId: existing.stripe_customer_id ?? stripeCustomerId,
      stripeSubscriptionId: existing.stripe_subscription_id ?? stripeSubscriptionId,
      stripePriceId: existing.stripe_price_id ?? null,
      currentPeriodEnd: existing.current_period_end ? new Date(existing.current_period_end) : null,
      advanceLifecycle: event.type === "invoice.payment_failed",
    });
  }

  return {
    async processEvent(input) {
      const event = validateEvent(input);
      if (!APPROVED_STRIPE_EVENTS.has(event.type)) {
        return record(event, {
          businessId: null, planKey: null, status: null, stripeCustomerId: null,
          stripeSubscriptionId: null, stripePriceId: null, currentPeriodEnd: null, result: "ignored",
          advanceLifecycle: false,
        }, "ignored");
      }
      if (event.type === "checkout.session.completed") return processCheckout(event, event.data.object);
      if (event.type.startsWith("customer.subscription.")) return processSubscription(event, event.data.object);
      return processInvoice(event, event.data.object);
    },
  };
}
