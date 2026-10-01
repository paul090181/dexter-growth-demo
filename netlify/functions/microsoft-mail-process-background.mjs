import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";
import { getMicrosoftMailAccess } from "./_microsoft-mail-access.mjs";
import { fetchMicrosoftMailMessage, MicrosoftMailGraphError } from "./_microsoft-mail-graph.mjs";
import { validateMicrosoftMailNotification } from "./_microsoft-mail-subscriptions.mjs";
import { ingestRetailLead } from "./_retail-lead-ingest.mjs";
import { normalizeRetailEmailPayload } from "./retail-email-ingest.mjs";

const PATH = "/.netlify/functions/microsoft-mail-process-background";
const MAX_BODY_BYTES = 192 * 1024;
const MAX_NOTIFICATIONS = 100;

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function expectedSignature(body, secret) {
  if (typeof secret !== "string" || secret.length < 16) return null;
  return createHmac("sha256", secret)
    .update("growthwise-microsoft-mail-dispatch-v1\n", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function readBoundedBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  return text;
}

function messageExternalId(message) {
  if (typeof message?.internetMessageId === "string" && message.internetMessageId.trim()) {
    return message.internetMessageId.trim().slice(0, 300);
  }
  return `msgraph:${createHash("sha256").update(String(message?.id ?? ""), "utf8").digest("hex")}`;
}

function emailAddress(entry) {
  const value = entry?.emailAddress;
  if (!value || typeof value !== "object") return null;
  const address = typeof value.address === "string" ? value.address.trim().toLowerCase() : "";
  if (!address || !address.includes("@")) return null;
  return {
    name: typeof value.name === "string" ? value.name.trim() : "",
    address,
  };
}

function normalizeGraphMessage({ businessId, mailboxAddress, message }) {
  if (!message || message.isDraft === true) return null;
  const from = emailAddress(message.from);
  if (!from) return null;

  const reply = Array.isArray(message.replyTo)
    ? message.replyTo.map(emailAddress).find(Boolean)
    : null;
  const bodyText = typeof message.body?.content === "string" && message.body.content.trim()
    ? message.body.content
    : typeof message.bodyPreview === "string" ? message.bodyPreview : "";
  const subject = typeof message.subject === "string" ? message.subject : "";

  if (!bodyText.trim() && !subject.trim()) return null;

  return normalizeRetailEmailPayload({
    business_id: businessId,
    from: from,
    to_email: mailboxAddress,
    reply_to: reply?.address || from.address,
    subject,
    text: bodyText,
    external_message_id: messageExternalId(message),
    external_thread_id: typeof message.conversationId === "string" ? message.conversationId : "",
    received_at: typeof message.receivedDateTime === "string" ? message.receivedDateTime : "",
  });
}

export async function processMicrosoftMailNotifications({
  notifications,
  now = new Date(),
  crypto = defaultCrypto(),
  store = createMicrosoftMailStore({ crypto }),
  access = getMicrosoftMailAccess,
  fetchMessage = fetchMicrosoftMailMessage,
  validateNotification = validateMicrosoftMailNotification,
  ingest = ingestRetailLead,
} = {}) {
  if (!Array.isArray(notifications) || notifications.length === 0
    || notifications.length > MAX_NOTIFICATIONS) {
    throw new Error("INVALID_NOTIFICATION_BATCH");
  }

  let processed = 0;
  let ignored = 0;
  let duplicates = 0;
  const retryable = [];

  for (const notification of notifications) {
    const subscriptionId = typeof notification?.subscriptionId === "string"
      ? notification.subscriptionId : "";
    const clientState = typeof notification?.clientState === "string"
      ? notification.clientState : "";
    const messageId = typeof notification?.resourceData?.id === "string"
      ? notification.resourceData.id : "";

    if (notification?.changeType !== "created" || !subscriptionId || !clientState || !messageId) {
      ignored += 1;
      continue;
    }

    const subscription = await validateNotification({
      subscriptionId,
      clientState,
      store,
      now,
    });
    if (!subscription) {
      ignored += 1;
      continue;
    }

    try {
      const auth = await access({
        businessId: subscription.business_id,
        now,
        crypto,
        store,
      });
      const message = await fetchMessage({
        accessToken: auth.accessToken,
        messageId,
      });
      const normalized = normalizeGraphMessage({
        businessId: subscription.business_id,
        mailboxAddress: auth.credential.email_address,
        message,
      });

      if (!normalized) {
        ignored += 1;
        await store.touchSubscriptionNotification({ subscriptionId, now });
        continue;
      }

      const result = await ingest(normalized, {
        ingestionTag: "microsoft-email",
      });
      if (result.duplicate) duplicates += 1;
      else processed += 1;

      await store.touchSubscriptionNotification({ subscriptionId, now });
    } catch (error) {
      if (error instanceof MicrosoftMailGraphError && error.httpStatus === 404) {
        ignored += 1;
        continue;
      }
      retryable.push(error);
    }
  }

  if (retryable.length) throw retryable[0];
  return { processed, ignored, duplicates };
}

export function createMicrosoftMailBackgroundHandler({
  dispatchSecret = () => env("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
  processBatch = processMicrosoftMailNotifications,
} = {}) {
  return async function microsoftMailProcessBackground(request) {
    if (request.method !== "POST") throw new Error("METHOD_NOT_ALLOWED");
    const url = new URL(request.url);
    if (url.pathname !== PATH || url.search || url.hash) throw new Error("INVALID_REQUEST");

    const body = await readBoundedBody(request);
    const expected = expectedSignature(body, dispatchSecret());
    const supplied = request.headers.get("x-growthwise-dispatch-signature");
    if (!expected || !safeEqualHex(supplied, expected)) {
      throw new Error("INVALID_DISPATCH_SIGNATURE");
    }

    let parsed;
    try { parsed = JSON.parse(body); }
    catch { throw new Error("INVALID_NOTIFICATION_BATCH"); }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.value)) {
      throw new Error("INVALID_NOTIFICATION_BATCH");
    }

    await processBatch({ notifications: parsed.value });
  };
}

export default createMicrosoftMailBackgroundHandler();

export const config = {
  background: true,
};
