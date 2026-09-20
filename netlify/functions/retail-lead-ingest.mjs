import { getDatabase } from "@netlify/database";

const SOURCES = new Set(["instagram","facebook","email","website","sms","phone","manual","other"]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function clean(value, max = 4000) { return String(value ?? "").trim().slice(0, max); }
function metadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const text = JSON.stringify(value);
    if (text.length > 8000) return { truncated: true };
    return value;
  } catch { return {}; }
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY") || "";
  const ingestKey = Netlify.env.get("GROWTHWISE_RETAIL_LEAD_INGEST_KEY") || "";
  const supplied = request.headers.get("x-growthwise-key") || request.headers.get("x-growthwise-ingest-key") || "";
  if (!supplied || (supplied !== adminKey && supplied !== ingestKey)) {
    return json(401, { error: "Invalid GrowthWise retail lead-ingest key." });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid request." }); }

  const businessId = clean(body.business_id, 120);
  const sourceType = clean(body.source_type, 40).toLowerCase();
  const source = clean(body.source, 120) || sourceType;
  const customerName = clean(body.customer_name, 180);
  const customerContact = clean(body.customer_contact, 260);
  const message = clean(body.message, 8000);
  const sourceAccount = clean(body.source_account, 260);
  const externalThreadId = clean(body.external_thread_id, 300);
  const externalMessageId = clean(body.external_message_id, 300);
  const replyTarget = clean(body.reply_target, 500);
  const replySupported = Boolean(body.reply_supported);
  const receivedAt = clean(body.received_at, 80);
  const sourceMetadata = metadata(body.source_metadata);

  if (!businessId) return json(400, { error: "business_id is required." });
  if (!SOURCES.has(sourceType)) return json(400, { error: "A supported source_type is required." });
  if (!message) return json(400, { error: "message is required." });

  let parsedReceived = new Date(receivedAt || Date.now());
  if (!Number.isFinite(parsedReceived.getTime())) parsedReceived = new Date();

  const db = getDatabase();

  if (externalMessageId) {
    const existing = await db.sql`
      SELECT *
        FROM retail_customer_leads
       WHERE business_id = ${businessId}
         AND source_type = ${sourceType}
         AND external_message_id = ${externalMessageId}
       LIMIT 1
    `;
    if (existing.length) return json(200, { ok: true, duplicate: true, lead: existing[0] });
  }

  const id = crypto.randomUUID();
  const rows = await db.sql`
    INSERT INTO retail_customer_leads
      (id,business_id,source,source_type,source_account,customer_name,customer_contact,message,
       external_thread_id,external_message_id,direction,received_at,unread,reply_supported,reply_target,source_metadata,status)
    VALUES
      (${id},${businessId},${source},${sourceType},${sourceAccount || null},
       ${customerName || null},${customerContact || null},${message},
       ${externalThreadId || null},${externalMessageId || null},'inbound',${parsedReceived.toISOString()},
       TRUE,${replySupported},${replyTarget || null},${JSON.stringify(sourceMetadata)}::jsonb,'new')
    RETURNING *
  `;

  await db.sql`
    INSERT INTO growthwise_lead_sources
      (business_id,source_type,display_name,status,inbound_enabled,outbound_enabled,last_event_at,details,updated_at)
    VALUES
      (${businessId},${sourceType},${source},'connected',TRUE,${replySupported},CURRENT_TIMESTAMP,
       ${JSON.stringify({ last_ingest: "normalized" })}::jsonb,CURRENT_TIMESTAMP)
    ON CONFLICT (business_id,source_type) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      status = 'connected',
      inbound_enabled = TRUE,
      outbound_enabled = growthwise_lead_sources.outbound_enabled OR EXCLUDED.outbound_enabled,
      last_event_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `;

  return json(201, { ok: true, duplicate: false, lead: rows[0] });
};
