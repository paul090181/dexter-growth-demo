const READ_SUBSCRIPTION = `
  SELECT business_id, access_source, plan_key, status, stripe_customer_id,
         stripe_subscription_id, stripe_price_id, current_period_end,
         plan_started_at, last_event_created_at, created_at, updated_at
    FROM growthwise_subscriptions
   WHERE business_id = $1`;

const LOCK_SUBSCRIPTION = `${READ_SUBSCRIPTION} FOR UPDATE`;

const READ_REGISTERED_TENANT = `
  SELECT business_id AS registered_tenant
    FROM growthwise_tenants
   WHERE business_id = $1
  UNION ALL
  SELECT business_id AS registered_tenant
    FROM growthwise_subscriptions
   WHERE business_id = $1
   LIMIT 1`;

const INSERT_EVENT = `
  INSERT INTO stripe_webhook_events
    (stripe_event_id, event_type, event_created_at, business_id, result)
  VALUES ($1, $2, $3, $4, $5)
  ON CONFLICT (stripe_event_id) DO NOTHING
  RETURNING stripe_event_id`;

const UPDATE_EVENT_RESULT = `
  UPDATE stripe_webhook_events
     SET result = $2, processed_at = CURRENT_TIMESTAMP
   WHERE stripe_event_id = $1
  RETURNING stripe_event_id`;

const FIND_BINDING_CONFLICT = `
  SELECT business_id
    FROM growthwise_subscriptions
   WHERE business_id <> $1
     AND (($2::text IS NOT NULL AND stripe_customer_id = $2)
       OR ($3::text IS NOT NULL AND stripe_subscription_id = $3))
   LIMIT 1`;

const FIND_SUBSCRIPTION_BY_STRIPE_IDS = `
  SELECT business_id, access_source, plan_key, status, stripe_customer_id,
         stripe_subscription_id, stripe_price_id, current_period_end,
         plan_started_at, last_event_created_at, created_at, updated_at
    FROM growthwise_subscriptions
   WHERE ($1::text IS NOT NULL AND stripe_customer_id = $1)
      OR ($2::text IS NOT NULL AND stripe_subscription_id = $2)
   LIMIT 2`;

const UPSERT_SUBSCRIPTION = `
  INSERT INTO growthwise_subscriptions
    (business_id, access_source, plan_key, status, stripe_customer_id,
     stripe_subscription_id, stripe_price_id, current_period_end,
     plan_started_at, last_event_created_at)
  VALUES ($1, 'stripe', $2, $3, $4, $5, $6, $7, COALESCE($8, CURRENT_TIMESTAMP), $8)
  ON CONFLICT (business_id) DO UPDATE SET
    plan_started_at = CASE
      WHEN growthwise_subscriptions.access_source = 'pilot' THEN growthwise_subscriptions.plan_started_at
      WHEN growthwise_subscriptions.plan_key IS DISTINCT FROM EXCLUDED.plan_key
        THEN COALESCE(EXCLUDED.last_event_created_at, CURRENT_TIMESTAMP)
      ELSE growthwise_subscriptions.plan_started_at
    END,
    plan_key = CASE WHEN growthwise_subscriptions.access_source = 'pilot'
      THEN growthwise_subscriptions.plan_key ELSE EXCLUDED.plan_key END,
    status = CASE WHEN growthwise_subscriptions.access_source = 'pilot'
      THEN growthwise_subscriptions.status ELSE EXCLUDED.status END,
    stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, growthwise_subscriptions.stripe_customer_id),
    stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, growthwise_subscriptions.stripe_subscription_id),
    stripe_price_id = COALESCE(EXCLUDED.stripe_price_id, growthwise_subscriptions.stripe_price_id),
    current_period_end = EXCLUDED.current_period_end,
    last_event_created_at = COALESCE(EXCLUDED.last_event_created_at, growthwise_subscriptions.last_event_created_at),
    updated_at = CURRENT_TIMESTAMP
  RETURNING business_id, access_source, plan_key, status, stripe_customer_id,
            stripe_subscription_id, stripe_price_id, current_period_end,
            plan_started_at, last_event_created_at, created_at, updated_at`;

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function safeStoreError(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function requiredString(value, code) {
  if (typeof value !== "string" || !value.trim()) throw safeStoreError(code);
  return value.trim();
}

function optionalString(value, code) {
  if (value == null) return null;
  return requiredString(value, code);
}

function validDate(value, code, { nullable = false } = {}) {
  if (value == null && nullable) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw safeStoreError(code);
  return date;
}

function validateEvent(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw safeStoreError("INVALID_BILLING_EVENT");
  const result = requiredString(input.result, "INVALID_EVENT_RESULT");
  if (!new Set(["processed", "ignored", "failed"]).has(result)) throw safeStoreError("INVALID_EVENT_RESULT");
  const businessId = input.businessId == null ? null : requiredString(input.businessId, "INVALID_BUSINESS_ID");
  if (!businessId && result !== "ignored") throw safeStoreError("INVALID_BUSINESS_ID");
  return {
    eventId: requiredString(input.eventId, "INVALID_EVENT_ID"),
    eventType: requiredString(input.eventType, "INVALID_EVENT_TYPE"),
    eventCreatedAt: validDate(input.eventCreatedAt, "INVALID_EVENT_CREATED_AT"),
    businessId,
    planKey: businessId ? requiredString(input.planKey, "INVALID_PLAN_KEY") : null,
    status: businessId ? requiredString(input.status, "INVALID_SUBSCRIPTION_STATUS") : null,
    stripeCustomerId: optionalString(input.stripeCustomerId, "INVALID_STRIPE_CUSTOMER_ID"),
    stripeSubscriptionId: optionalString(input.stripeSubscriptionId, "INVALID_STRIPE_SUBSCRIPTION_ID"),
    stripePriceId: optionalString(input.stripePriceId, "INVALID_STRIPE_PRICE_ID"),
    currentPeriodEnd: validDate(input.currentPeriodEnd, "INVALID_CURRENT_PERIOD_END", { nullable: true }),
    advanceLifecycle: input.advanceLifecycle !== false,
    result,
  };
}

function bindingChanged(existing, event) {
  return (existing.stripe_customer_id && event.stripeCustomerId && existing.stripe_customer_id !== event.stripeCustomerId)
    || (existing.stripe_subscription_id && event.stripeSubscriptionId && existing.stripe_subscription_id !== event.stripeSubscriptionId);
}

export function createBillingStore({ getPool = netlifyPool } = {}) {
  async function readSubscription({ businessId } = {}) {
    const id = requiredString(businessId, "INVALID_BUSINESS_ID");
    try {
      const result = await (await getPool()).query(READ_SUBSCRIPTION, [id]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (error?.message === "INVALID_BUSINESS_ID") throw error;
      throw safeStoreError("SUBSCRIPTION_READ_FAILED", error);
    }
  }

  async function applyEvent(input) {
    const event = validateEvent(input);
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (event.businessId) {
        const registered = await client.query(READ_REGISTERED_TENANT, [event.businessId]);
        if (!registered.rows[0]) throw safeStoreError("TENANT_NOT_REGISTERED");
      }
      const inserted = await client.query(INSERT_EVENT, [
        event.eventId, event.eventType, event.eventCreatedAt, event.businessId, event.result,
      ]);
      if (!inserted.rows[0]) {
        const subscription = event.businessId
          ? (await client.query(LOCK_SUBSCRIPTION, [event.businessId])).rows[0] ?? null
          : null;
        await client.query("COMMIT");
        return { duplicate: true, stale: false, subscription };
      }

      if (!event.businessId) {
        await client.query("COMMIT");
        return { duplicate: false, stale: false, subscription: null };
      }

      const conflicting = await client.query(FIND_BINDING_CONFLICT, [
        event.businessId, event.stripeCustomerId, event.stripeSubscriptionId,
      ]);
      if (conflicting.rows[0]) throw safeStoreError("STRIPE_BINDING_CONFLICT");

      const existing = (await client.query(LOCK_SUBSCRIPTION, [event.businessId])).rows[0] ?? null;
      if (existing && bindingChanged(existing, event)) throw safeStoreError("STRIPE_BINDING_CONFLICT");

      const lastEventAt = existing?.last_event_created_at ? new Date(existing.last_event_created_at) : null;
      if (event.advanceLifecycle && lastEventAt && event.eventCreatedAt.getTime() < lastEventAt.getTime()) {
        await client.query(UPDATE_EVENT_RESULT, [event.eventId, "ignored"]);
        await client.query("COMMIT");
        return { duplicate: false, stale: true, subscription: existing };
      }

      let subscription;
      try {
        const updated = await client.query(UPSERT_SUBSCRIPTION, [
          event.businessId,
          event.planKey,
          event.status,
          event.stripeCustomerId,
          event.stripeSubscriptionId,
          event.stripePriceId,
          event.currentPeriodEnd,
          event.advanceLifecycle ? event.eventCreatedAt : null,
        ]);
        subscription = updated.rows[0] ?? existing;
      } catch (error) {
        if (error?.code === "23505") throw safeStoreError("STRIPE_BINDING_CONFLICT", error);
        throw error;
      }

      await client.query("COMMIT");
      return { duplicate: false, stale: false, subscription };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* keep the original safe error */ }
      if (["STRIPE_BINDING_CONFLICT", "INVALID_BILLING_EVENT", "TENANT_NOT_REGISTERED"].includes(error?.message)) throw error;
      throw safeStoreError("BILLING_EVENT_APPLY_FAILED", error);
    } finally {
      client.release();
    }
  }

  async function findSubscriptionByStripeIds({ stripeCustomerId, stripeSubscriptionId } = {}) {
    const customerId = optionalString(stripeCustomerId, "INVALID_STRIPE_CUSTOMER_ID");
    const subscriptionId = optionalString(stripeSubscriptionId, "INVALID_STRIPE_SUBSCRIPTION_ID");
    if (!customerId && !subscriptionId) throw safeStoreError("INVALID_STRIPE_BINDING_LOOKUP");
    try {
      const result = await (await getPool()).query(FIND_SUBSCRIPTION_BY_STRIPE_IDS, [customerId, subscriptionId]);
      if (result.rows.length > 1) throw safeStoreError("STRIPE_BINDING_CONFLICT");
      return result.rows[0] ?? null;
    } catch (error) {
      if (error?.message === "STRIPE_BINDING_CONFLICT") throw error;
      throw safeStoreError("SUBSCRIPTION_LOOKUP_FAILED", error);
    }
  }

  return { readSubscription, findSubscriptionByStripeIds, applyEvent };
}
