import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createMicrosoftMailSubscription,
  deleteMicrosoftMailSubscription,
  renewMicrosoftMailSubscription,
} from "./_microsoft-mail-graph.mjs";

export const MICROSOFT_MAIL_RESOURCE = "me/mailFolders('Inbox')/messages";
export const MICROSOFT_MAIL_SUBSCRIPTION_LIFETIME_MS = 10_020 * 60 * 1000;
export const MICROSOFT_MAIL_RENEW_WINDOW_MS = 48 * 60 * 60 * 1000;

function hashClientState(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function safeHashEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function microsoftMailNotificationUrl(publicOrigin) {
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Invalid public origin.");
  }
  return `${origin.origin}/.netlify/functions/microsoft-mail-webhook`;
}

export function newMicrosoftMailClientState({ randomBytesImpl = randomBytes } = {}) {
  const value = Buffer.from(randomBytesImpl(32));
  if (value.length !== 32) throw new Error("INVALID_RANDOM_SOURCE");
  return value.toString("base64url");
}

export async function createAndStoreMicrosoftMailSubscription({
  businessId,
  accessToken,
  publicOrigin,
  store,
  now = new Date(),
  createSubscription = createMicrosoftMailSubscription,
  deleteSubscription = deleteMicrosoftMailSubscription,
  randomBytesImpl = randomBytes,
} = {}) {
  if (typeof businessId !== "string" || !businessId || !store?.upsertSubscription
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("INVALID_SUBSCRIPTION_REQUEST");
  }

  const clientState = newMicrosoftMailClientState({ randomBytesImpl });
  const expirationDateTime = new Date(now.getTime() + MICROSOFT_MAIL_SUBSCRIPTION_LIFETIME_MS);
  const notificationUrl = microsoftMailNotificationUrl(publicOrigin);

  const remote = await createSubscription({
    accessToken,
    notificationUrl,
    clientState,
    expirationDateTime,
  });

  if (!remote
    || typeof remote.subscriptionId !== "string" || !remote.subscriptionId
    || remote.resource !== MICROSOFT_MAIL_RESOURCE
    || !(remote.expiresAt instanceof Date) || !Number.isFinite(remote.expiresAt.getTime())) {
    throw new Error("INVALID_SUBSCRIPTION_RESPONSE");
  }

  try {
    return await store.upsertSubscription({
      businessId,
      subscriptionId: remote.subscriptionId,
      clientStateHash: hashClientState(clientState),
      resource: MICROSOFT_MAIL_RESOURCE,
      expiresAt: remote.expiresAt,
      lastRenewedAt: now,
    });
  } catch (error) {
    try {
      await deleteSubscription({
        accessToken,
        subscriptionId: remote.subscriptionId,
      });
    } catch {}
    throw error;
  }
}

export async function validateMicrosoftMailNotification({
  subscriptionId,
  clientState,
  store,
  now = new Date(),
} = {}) {
  if (typeof subscriptionId !== "string" || !subscriptionId
    || typeof clientState !== "string" || !clientState
    || !store?.readSubscriptionById
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return null;
  }

  let row;
  try {
    row = await store.readSubscriptionById({ subscriptionId });
  } catch {
    return null;
  }

  if (!row
    || row.status !== "active"
    || row.subscription_id !== subscriptionId
    || row.resource !== MICROSOFT_MAIL_RESOURCE
    || new Date(row.expires_at).getTime() <= now.getTime()
    || !safeHashEqual(hashClientState(clientState), row.client_state_hash)) {
    return null;
  }

  return row;
}

export async function renewMicrosoftMailSubscriptionRecord({
  subscription,
  accessToken,
  store,
  now = new Date(),
  renewSubscription = renewMicrosoftMailSubscription,
} = {}) {
  if (!subscription
    || typeof subscription.business_id !== "string"
    || typeof subscription.subscription_id !== "string"
    || !store?.updateSubscriptionExpiry
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("INVALID_SUBSCRIPTION_REQUEST");
  }

  const requestedExpiry = new Date(now.getTime() + MICROSOFT_MAIL_SUBSCRIPTION_LIFETIME_MS);
  const remote = await renewSubscription({
    accessToken,
    subscriptionId: subscription.subscription_id,
    expirationDateTime: requestedExpiry,
  });

  return store.updateSubscriptionExpiry({
    businessId: subscription.business_id,
    subscriptionId: subscription.subscription_id,
    expiresAt: remote.expiresAt,
    now,
  });
}

export function microsoftMailRenewBefore(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new TypeError("Invalid time.");
  }
  return new Date(now.getTime() + MICROSOFT_MAIL_RENEW_WINDOW_MS);
}
