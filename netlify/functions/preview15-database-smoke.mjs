import { getDatabase } from "@netlify/database";
import { json } from "./_lead-store.mjs";

function isPreview15() {
  const context = Netlify.env.get("CONTEXT") || "";
  const prime = Netlify.env.get("DEPLOY_PRIME_URL") || "";
  return context === "deploy-preview" && prime.includes("deploy-preview-15--");
}

export default async function handler(request) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!isPreview15()) return json(404, { error: "Not found" });

  const client = await getDatabase().pool.connect();
  try {
    await client.query("BEGIN");

    const schema = await client.query(`
      SELECT
        to_regclass('public.growthwise_acquisition_attribution') IS NOT NULL AS attribution_table,
        EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = 'growthwise_subscriptions'
             AND column_name = 'plan_started_at'
        ) AS plan_started_at_column
    `);

    if (!schema.rows[0]?.attribution_table || !schema.rows[0]?.plan_started_at_column) {
      await client.query("ROLLBACK");
      return json(503, {
        ok: false,
        attribution_table: Boolean(schema.rows[0]?.attribution_table),
        plan_started_at_column: Boolean(schema.rows[0]?.plan_started_at_column),
        write_read_rollback: false,
      });
    }

    const businessId = `smoke-preview15-${Date.now()}`;
    const sessionId = `cs_smoke_preview15_${Date.now()}`;
    await client.query(
      `INSERT INTO growthwise_acquisition_attribution
        (business_id, source_kind, campaign_code, stripe_promotion_code_id,
         stripe_coupon_id, stripe_checkout_session_id, acquisition_plan_key,
         source_channel, campaign_name, attributed_at)
       VALUES ($1, 'stripe_promotion_code', 'SMOKE20', 'promo_smoke',
               'coupon_smoke', $2, 'growth_monthly',
               'smoke_test', 'Preview 15 smoke test', CURRENT_TIMESTAMP)`,
      [businessId, sessionId],
    );

    const read = await client.query(
      `SELECT campaign_code, acquisition_plan_key, source_channel
         FROM growthwise_acquisition_attribution
        WHERE business_id = $1`,
      [businessId],
    );

    const writeReadOk = read.rows.length === 1
      && read.rows[0].campaign_code === "SMOKE20"
      && read.rows[0].acquisition_plan_key === "growth_monthly"
      && read.rows[0].source_channel === "smoke_test";

    await client.query("ROLLBACK");

    return json(writeReadOk ? 200 : 503, {
      ok: writeReadOk,
      attribution_table: true,
      plan_started_at_column: true,
      write_read_rollback: writeReadOk,
      persisted_test_rows: 0,
    });
  } catch {
    try { await client.query("ROLLBACK"); } catch {}
    return json(503, {
      ok: false,
      attribution_table: false,
      plan_started_at_column: false,
      write_read_rollback: false,
    });
  } finally {
    client.release();
  }
}
