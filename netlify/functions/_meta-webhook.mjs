import { createHmac, timingSafeEqual } from "node:crypto";

const OBJECT_CONFIG = Object.freeze({
  page: Object.freeze({ sourceType: "facebook", source: "Facebook Messenger" }),
  instagram: Object.freeze({ sourceType: "instagram", source: "Instagram DM" }),
});
const BUSINESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const ACCOUNT_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const MAX_ACCOUNTS_PER_SOURCE = 100;

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function safeHttpsUrl(value) {
  const text = clean(value, 3000);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" && !url.username && !url.password ? url.toString().slice(0, 3000) : null;
  } catch {
    return null;
  }
}

function normalizeSourceMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value).slice(0, MAX_ACCOUNTS_PER_SOURCE);
  const result = {};
  for (const [accountId, businessId] of entries) {
    const account = clean(accountId, 200);
    const business = clean(businessId, 120);
    if (ACCOUNT_ID.test(account) && BUSINESS_ID.test(business)) result[account] = business;
  }
  return result;
}

export function parseMetaAccountMap(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    if (!raw.trim()) return { facebook: {}, instagram: {} };
    try { parsed = JSON.parse(raw); }
    catch { throw new TypeError("GROWTHWISE_META_ACCOUNT_MAP must be valid JSON."); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("GROWTHWISE_META_ACCOUNT_MAP must be an object.");
  }
  return {
    facebook: normalizeSourceMap(parsed.facebook),
    instagram: normalizeSourceMap(parsed.instagram),
  };
}

export function resolveMetaBusinessId({ accountMap, sourceType, accountId }) {
  const source = sourceType === "facebook" ? "facebook" : sourceType === "instagram" ? "instagram" : "";
  const account = clean(accountId, 200);
  if (!source || !account) return null;
  const business = accountMap?.[source]?.[account];
  return typeof business === "string" && BUSINESS_ID.test(business) ? business : null;
}

export function verifyMetaSignature({ rawBody, signature, appSecret }) {
  const secret = typeof appSecret === "string" ? appSecret : "";
  const header = typeof signature === "string" ? signature.trim().toLowerCase() : "";
  if (!secret || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(String(rawBody ?? ""), "utf8").digest("hex")}`;
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(header, "utf8");
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

export function secureTextMatch(left, right) {
  const a = Buffer.from(String(left ?? ""), "utf8");
  const b = Buffer.from(String(right ?? ""), "utf8");
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return new Date().toISOString();
  const millis = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 8).map((attachment) => {
    const payload = attachment?.payload && typeof attachment.payload === "object" ? attachment.payload : {};
    const normalized = { type: clean(attachment?.type, 80) || "attachment" };
    const url = safeHttpsUrl(payload.url);
    if (url) normalized.url = url;
    const providerId = clean(payload.id, 200);
    if (providerId) normalized.id = providerId;
    return normalized;
  });
}

function attachmentMessage(attachments) {
  if (!attachments.length) return "";
  if (attachments.length === 1) {
    const type = attachments[0].type === "image" ? "image" : attachments[0].type === "video" ? "video" : "attachment";
    return `Customer sent an ${type}.`;
  }
  return `Customer sent ${attachments.length} attachments.`;
}

function metadataFor({ objectType, entry, event, accountId, senderId, attachments }) {
  const result = {
    provider: "meta",
    webhook_object: objectType,
    account_id: accountId,
    sender_id: senderId,
  };
  const recipientId = clean(event?.recipient?.id, 200);
  if (recipientId) result.recipient_id = recipientId;
  if (attachments.length) result.attachments = attachments;
  const replyTo = clean(event?.message?.reply_to?.mid, 300);
  if (replyTo) result.reply_to_message_id = replyTo;
  const quickReplyPayload = clean(event?.message?.quick_reply?.payload, 1000);
  if (quickReplyPayload) result.quick_reply_payload = quickReplyPayload;
  const entryTime = Number(entry?.time);
  if (Number.isFinite(entryTime) && entryTime > 0) result.entry_time = entryTime;
  return result;
}

export function normalizeMetaWebhookPayload(payload, { accountMap } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { events: [], unrouted: [], ignored: 1 };
  }
  const objectType = clean(payload.object, 40).toLowerCase();
  const config = OBJECT_CONFIG[objectType];
  if (!config) return { events: [], unrouted: [], ignored: 1 };

  const events = [];
  const unrouted = [];
  let ignored = 0;
  for (const entry of Array.isArray(payload.entry) ? payload.entry.slice(0, 100) : []) {
    const entryAccountId = clean(entry?.id, 200);
    for (const event of Array.isArray(entry?.messaging) ? entry.messaging.slice(0, 100) : []) {
      const message = event?.message;
      if (!message || typeof message !== "object" || message.is_echo === true) {
        ignored += 1;
        continue;
      }
      const senderId = clean(event?.sender?.id, 200);
      const accountId = entryAccountId || clean(event?.recipient?.id, 200);
      const messageId = clean(message?.mid, 300);
      const attachments = normalizeAttachments(message?.attachments);
      const text = clean(message?.text, 8000) || attachmentMessage(attachments);
      if (!senderId || !accountId || !text) {
        ignored += 1;
        continue;
      }
      const businessId = resolveMetaBusinessId({ accountMap, sourceType: config.sourceType, accountId });
      if (!businessId) {
        unrouted.push({ source_type: config.sourceType, source_account: accountId });
        continue;
      }
      events.push({
        business_id: businessId,
        source_type: config.sourceType,
        source: config.source,
        customer_name: "",
        customer_contact: "",
        message: text,
        source_account: accountId,
        external_thread_id: `${config.sourceType}:${accountId}:${senderId}`.slice(0, 300),
        external_message_id: messageId,
        reply_supported: false,
        reply_target: senderId,
        received_at: normalizeTimestamp(event?.timestamp ?? entry?.time),
        source_metadata: metadataFor({ objectType, entry, event, accountId, senderId, attachments }),
      });
    }
  }
  return { events, unrouted, ignored };
}
