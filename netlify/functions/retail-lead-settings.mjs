import { getDatabase } from "@netlify/database";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

const DEFAULT_REPLY = ["availability","price","product_details","size_color","store_visit"];
const DEFAULT_ACK = ["shipping","discount","hold","custom_order","complaint"];

export default async (request) => {
  if (!["GET","PUT"].includes(request.method)) return json(405, { error: "Method not allowed." });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  if (!adminKey || (request.headers.get("x-growthwise-key") || "") !== adminKey) {
    return json(401, { error: "Invalid GrowthWise access key." });
  }

  const db = getDatabase();
  const url = new URL(request.url);
  const businessId = clean(url.searchParams.get("business_id") || "dexters-hats", 120);

  if (request.method === "GET") {
    const rows = await db.sql`
      SELECT business_id, mode, auto_reply_intents, auto_ack_intents, pause_auto_replies, updated_at
        FROM retail_lead_automation_settings
       WHERE business_id = ${businessId}
       LIMIT 1
    `;
    if (!rows.length) {
      await db.sql`
        INSERT INTO retail_lead_automation_settings
          (business_id, mode, auto_reply_intents, auto_ack_intents, pause_auto_replies)
        VALUES
          (${businessId}, 'shadow', ${JSON.stringify(DEFAULT_REPLY)}::jsonb, ${JSON.stringify(DEFAULT_ACK)}::jsonb, FALSE)
      `;
      return json(200, {
        ok: true,
        settings: {
          business_id: businessId,
          mode: "shadow",
          auto_reply_intents: DEFAULT_REPLY,
          auto_ack_intents: DEFAULT_ACK,
          pause_auto_replies: false,
        }
      });
    }
    return json(200, { ok: true, settings: rows[0] });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid request." }); }

  const requestedMode = clean(body.mode, 40);
  if (!["draft_only","shadow"].includes(requestedMode)) {
    return json(400, { error: "Live Smart Auto is not available until a supported customer-messaging channel is connected and approved." });
  }

  const pause = Boolean(body.pause_auto_replies);
  const rows = await db.sql`
    INSERT INTO retail_lead_automation_settings
      (business_id, mode, auto_reply_intents, auto_ack_intents, pause_auto_replies, updated_at)
    VALUES
      (${businessId}, ${requestedMode}, ${JSON.stringify(DEFAULT_REPLY)}::jsonb, ${JSON.stringify(DEFAULT_ACK)}::jsonb, ${pause}, CURRENT_TIMESTAMP)
    ON CONFLICT (business_id) DO UPDATE SET
      mode = EXCLUDED.mode,
      auto_reply_intents = EXCLUDED.auto_reply_intents,
      auto_ack_intents = EXCLUDED.auto_ack_intents,
      pause_auto_replies = EXCLUDED.pause_auto_replies,
      updated_at = CURRENT_TIMESTAMP
    RETURNING business_id, mode, auto_reply_intents, auto_ack_intents, pause_auto_replies, updated_at
  `;

  return json(200, { ok: true, settings: rows[0] });
};
