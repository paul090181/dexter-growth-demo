import { getDatabase } from "@netlify/database";

export const RETAIL_LEAD_SOURCES = Object.freeze([
  "instagram",
  "facebook",
  "email",
  "website",
  "sms",
  "phone",
  "manual",
  "other",
]);
const SOURCE_SET = new Set(RETAIL_LEAD_SOURCES);

export class RetailLeadIngestError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = "RetailLeadIngestError";
    this.code = code;
    this.status = status;
  }
}

export function cleanLeadValue(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

export function boundedLeadMetadata(value, maxBytes = 8000) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  try {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).byteLength > maxBytes) return { truncated: true };
    return value;
  } catch {
    return {};
  }
}

function normalizeReceivedAt(value) {
  const parsed = new Date(cleanLeadValue(value, 80) || Date.now());
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date().toISOString();
}

function normalizeInput(input = {}) {
  const businessId = cleanLeadValue(input.business_id, 120);
  const sourceType = cleanLeadValue(input.source_type, 40).toLowerCase();
  const source = cleanLeadValue(input.source, 120) || sourceType;
  const message = cleanLeadValue(input.message, 8000);

  if (!businessId) throw new RetailLeadIngestError("BUSINESS_ID_REQUIRED", "business_id is required.");
  if (!SOURCE_SET.has(sourceType)) throw new RetailLeadIngestError("SOURCE_TYPE_REQUIRED", "A supported source_type is required.");
  if (!message) throw new RetailLeadIngestError("MESSAGE_REQUIRED", "message is required.");

  return {
    businessId,
    sourceType,
    source,
    customerName: cleanLeadValue(input.customer_name, 180),
    customerContact: cleanLeadValue(input.customer_contact, 260),
    message,
    sourceAccount: cleanLeadValue(input.source_account, 260),
    externalThreadId: cleanLeadValue(input.external_thread_id, 300),
    externalMessageId: cleanLeadValue(input.external_message_id, 300),
    replyTarget: cleanLeadValue(input.reply_target, 500),
    replySupported: Boolean(input.reply_supported),
    receivedAt: normalizeReceivedAt(input.received_at),
    sourceMetadata: boundedLeadMetadata(input.source_metadata),
  };
}

async function findDuplicate(db, value) {
  if (!value.externalMessageId) return null;
  const rows = await db.sql`
    SELECT *
      FROM retail_customer_leads
     WHERE business_id = ${value.businessId}
       AND source_type = ${value.sourceType}
       AND external_message_id = ${value.externalMessageId}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

async function markSourceConnected(db, value, ingestionTag) {
  const details = boundedLeadMetadata({
    last_ingest: cleanLeadValue(ingestionTag, 80) || "normalized",
    source_account: value.sourceAccount || undefined,
  });
  await db.sql`
    INSERT INTO growthwise_lead_sources
      (business_id,source_type,display_name,status,inbound_enabled,outbound_enabled,last_event_at,details,updated_at)
    VALUES
      (${value.businessId},${value.sourceType},${value.source},'connected',TRUE,${value.replySupported},CURRENT_TIMESTAMP,
       ${JSON.stringify(details)}::jsonb,CURRENT_TIMESTAMP)
    ON CONFLICT (business_id,source_type) DO UPDATE SET
      display_name = EXCLUDED.display_name,
      status = 'connected',
      inbound_enabled = TRUE,
      outbound_enabled = growthwise_lead_sources.outbound_enabled OR EXCLUDED.outbound_enabled,
      last_event_at = CURRENT_TIMESTAMP,
      details = EXCLUDED.details,
      updated_at = CURRENT_TIMESTAMP
  `;
}

export async function ingestRetailLead(input, {
  db = getDatabase(),
  ingestionTag = "normalized",
} = {}) {
  const value = normalizeInput(input);
  const existing = await findDuplicate(db, value);
  if (existing) return { duplicate: true, lead: existing };

  const id = crypto.randomUUID();
  let rows;
  try {
    rows = await db.sql`
      INSERT INTO retail_customer_leads
        (id,business_id,source,source_type,source_account,customer_name,customer_contact,message,
         external_thread_id,external_message_id,direction,received_at,unread,reply_supported,reply_target,source_metadata,status)
      VALUES
        (${id},${value.businessId},${value.source},${value.sourceType},${value.sourceAccount || null},
         ${value.customerName || null},${value.customerContact || null},${value.message},
         ${value.externalThreadId || null},${value.externalMessageId || null},'inbound',${value.receivedAt},
         TRUE,${value.replySupported},${value.replyTarget || null},${JSON.stringify(value.sourceMetadata)}::jsonb,'new')
      RETURNING *
    `;
  } catch (error) {
    if (error?.code === "23505" && value.externalMessageId) {
      const duplicate = await findDuplicate(db, value);
      if (duplicate) return { duplicate: true, lead: duplicate };
    }
    throw error;
  }

  await markSourceConnected(db, value, ingestionTag);
  return { duplicate: false, lead: rows[0] };
}
