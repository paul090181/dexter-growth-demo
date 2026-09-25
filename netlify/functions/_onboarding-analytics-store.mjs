const ALLOWED_EVENTS = new Set([
  "workspace_created",
  "checkout_started",
  "checkout_completed",
  "workspace_opened",
  "square_connect_started",
  "square_connected",
  "business_pulse_loaded",
  "ai_workflow_used",
]);

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function clean(value, max = 200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createOnboardingAnalyticsStore({ getPool = netlifyPool } = {}) {
  async function recordEvent({ businessId, eventName, occurredAt = new Date() } = {}) {
    const id = clean(businessId, 200);
    const name = clean(eventName, 80);
    const time = occurredAt instanceof Date ? occurredAt : new Date(occurredAt);

    if (!id || !ALLOWED_EVENTS.has(name) || !Number.isFinite(time.getTime())) {
      throw new Error("INVALID_ONBOARDING_EVENT");
    }

    const sql = `
      INSERT INTO growthwise_onboarding_events
        (business_id, event_name, occurred_at, occurred_on)
      VALUES ($1, $2, $3, ($3 AT TIME ZONE 'UTC')::date)
      ON CONFLICT (business_id, event_name, occurred_on) DO NOTHING
      RETURNING business_id, event_name, occurred_at, occurred_on
    `;

    try {
      const result = await (await getPool()).query(sql, [id, name, time]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw new Error("ONBOARDING_EVENT_WRITE_FAILED", { cause: error });
    }
  }

  async function listFunnelRows() {
    const sql = `
      WITH event_rollup AS (
        SELECT
          business_id,
          MIN(occurred_at) FILTER (WHERE event_name = 'workspace_created') AS workspace_created_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'checkout_started') AS checkout_started_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'checkout_completed') AS checkout_completed_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'workspace_opened') AS workspace_opened_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'square_connect_started') AS square_connect_started_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'square_connected') AS square_connected_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'business_pulse_loaded') AS business_pulse_loaded_at,
          MIN(occurred_at) FILTER (WHERE event_name = 'ai_workflow_used') AS ai_workflow_used_at,
          COUNT(DISTINCT occurred_on) FILTER (WHERE event_name = 'workspace_opened')::int AS workspace_open_days
        FROM growthwise_onboarding_events
        GROUP BY business_id
      ),
      derived AS (
        SELECT
          e.*,
          CASE
            WHEN e.business_pulse_loaded_at IS NULL THEN e.ai_workflow_used_at
            WHEN e.ai_workflow_used_at IS NULL THEN e.business_pulse_loaded_at
            ELSE LEAST(e.business_pulse_loaded_at, e.ai_workflow_used_at)
          END AS first_value_at
        FROM event_rollup e
      )
      SELECT
        d.*,
        EXISTS (
          SELECT 1
          FROM growthwise_onboarding_events v
          WHERE v.business_id = d.business_id
            AND v.event_name = 'workspace_opened'
            AND d.first_value_at IS NOT NULL
            AND v.occurred_on > (d.first_value_at AT TIME ZONE 'UTC')::date
        ) AS returned_after_first_value,
        a.campaign_code,
        a.source_channel,
        a.campaign_name,
        a.acquisition_plan_key,
        s.plan_key AS current_plan_key,
        s.status AS subscription_status,
        s.access_source
      FROM derived d
      LEFT JOIN growthwise_acquisition_attribution a
        ON a.business_id = d.business_id
      LEFT JOIN growthwise_subscriptions s
        ON s.business_id = d.business_id
      ORDER BY COALESCE(d.workspace_created_at, d.workspace_opened_at) ASC, d.business_id ASC
    `;

    try {
      const result = await (await getPool()).query(sql);
      return result.rows;
    } catch (error) {
      throw new Error("ONBOARDING_FUNNEL_READ_FAILED", { cause: error });
    }
  }

  return { recordEvent, listFunnelRows };
}

export { ALLOWED_EVENTS };
