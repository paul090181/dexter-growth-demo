import { timingSafeEqual } from "node:crypto";
import { ingestRetailLead, RetailLeadIngestError } from "./_retail-lead-ingest.mjs";

const MAX_BODY_BYTES = 128 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clean(value, max = 8000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function emailAddress(value) {
  if (value && typeof value === "object") {
    return clean(value.email || value.address, 320).toLowerCase();
  }
  const text = clean(value, 500);
  const bracket = text.match(/<([^<>\s]+@[^<>\s]+)>/);
  if (bracket) return bracket[1].toLowerCase();
  const bare = text.match(/\b[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+\b/);
  return bare ? bare[0].toLowerCase() : "";
}

function emailName(value) {
  if (value && typeof value === "object") return clean(value.name, 180);
  const text = clean(value, 500);
  if (!text.includes("<")) return "";
  return clean(text.split("<")[0].replace(/^["']|["']$/g, ""), 180);
}

function firstRecipient(value) {
  if (Array.isArray(value)) return firstRecipient(value[0]);
  return emailAddress(value) || clean(value, 320).toLowerCase();
}

export function normalizeRetailEmailPayload(body = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RetailLeadIngestError("INVALID_EMAIL_PAYLOAD", "Invalid email payload.");
  }

  const businessId = clean(body.business_id, 120);
  const sender = emailAddress(body.from || body.sender || body.from_email);
  const senderName = clean(body.from_name, 180) || emailName(body.from || body.sender);
  const recipient = firstRecipient(body.to || body.recipient || body.to_email);
  const replyTo = emailAddress(body.reply_to || body.replyTo) || sender;
  const subject = clean(body.subject, 500);
  const plainText = clean(body.text || body.plain_text || body.text_body || body.body, 7500);
  const message = subject && plainText
    ? `Subject: ${subject}\n\n${plainText}`
    : plainText || (subject ? `Subject: ${subject}` : "");
  const externalMessageId = clean(
    body.external_message_id || body.message_id || body.messageId || body.id,
    300,
  );
  const externalThreadId = clean(
    body.external_thread_id || body.thread_id || body.threadId,
    300,
  );

  if (!businessId) {
    throw new RetailLeadIngestError("BUSINESS_ID_REQUIRED", "business_id is required.");
  }
  if (!sender) {
    throw new RetailLeadIngestError("SENDER_REQUIRED", "A valid sender email is required.");
  }
  if (!message) {
    throw new RetailLeadIngestError("MESSAGE_REQUIRED", "Email subject or plain-text body is required.");
  }

  return {
    business_id: businessId,
    source_type: "email",
    source: "Email",
    customer_name: senderName,
    customer_contact: sender,
    message,
    source_account: recipient,
    external_thread_id: externalThreadId,
    external_message_id: externalMessageId,
    reply_target: replyTo,
    reply_supported: false,
    received_at: clean(body.received_at || body.date, 80),
    source_metadata: {
      subject,
      to: recipient,
      reply_to: replyTo,
      has_plain_text: Boolean(plainText),
    },
  };
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new RetailLeadIngestError("REQUEST_TOO_LARGE", "Email payload is too large.", 413);
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RetailLeadIngestError("REQUEST_TOO_LARGE", "Email payload is too large.", 413);
  }

  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new RetailLeadIngestError("INVALID_JSON", "Invalid request.", 400);
  }
}

export function createRetailEmailIngestHandler({
  ingest = ingestRetailLead,
  getAdminKey = () => Netlify.env.get("GROWTHWISE_ADMIN_KEY") || "",
  getIngestKey = () => Netlify.env.get("GROWTHWISE_RETAIL_LEAD_INGEST_KEY") || "",
} = {}) {
  return async function retailEmailIngestHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    const supplied = request.headers.get("x-growthwise-key")
      || request.headers.get("x-growthwise-ingest-key")
      || "";
    const authorized = safeEqual(supplied, getAdminKey()) || safeEqual(supplied, getIngestKey());
    if (!authorized) return json(401, { error: "Invalid GrowthWise email-ingest key." });

    try {
      const body = await readJson(request);
      const normalized = normalizeRetailEmailPayload(body);
      const result = await ingest(normalized, { ingestionTag: "email" });
      return json(result.duplicate ? 200 : 201, {
        ok: true,
        duplicate: Boolean(result.duplicate),
        id: result.lead?.id || null,
        source_type: "email",
      });
    } catch (error) {
      if (error instanceof RetailLeadIngestError) {
        return json(error.status || 400, { error: error.message });
      }
      return json(500, { error: "Email lead could not be ingested." });
    }
  };
}

export default createRetailEmailIngestHandler();
