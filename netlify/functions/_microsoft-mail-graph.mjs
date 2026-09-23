const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_V1 = `${GRAPH_ORIGIN}/v1.0`;
const MAX_JSON_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;

export class MicrosoftMailGraphError extends Error {
  constructor(code, { httpStatus = null } = {}) {
    super(code);
    this.name = "MicrosoftMailGraphError";
    this.code = code;
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
  }
}

function requireText(value, label, max = 4096) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function requireDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

async function readJson(response) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
    throw new MicrosoftMailGraphError("response_too_large", { httpStatus: response.status });
  }
  try { return JSON.parse(text); }
  catch { throw new MicrosoftMailGraphError("invalid_json", { httpStatus: response.status }); }
}

async function graphFetch(url, init, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new MicrosoftMailGraphError("network_error");
  }
  return response;
}

function bearer(accessToken) {
  return { Authorization: `Bearer ${requireText(accessToken, "access token")}` };
}

export async function createMicrosoftMailSubscription({
  accessToken,
  notificationUrl,
  clientState,
  expirationDateTime,
  fetchImpl = fetch,
}) {
  const notify = new URL(requireText(notificationUrl, "notification URL"));
  if (notify.protocol !== "https:" || notify.username || notify.password || notify.hash) {
    throw new TypeError("Invalid notification URL.");
  }
  requireDate(expirationDateTime, "expiration");

  const response = await graphFetch(`${GRAPH_V1}/subscriptions`, {
    method: "POST",
    headers: {
      ...bearer(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      changeType: "created",
      notificationUrl: notify.toString(),
      resource: "me/mailFolders('Inbox')/messages",
      expirationDateTime: expirationDateTime.toISOString(),
      clientState: requireText(clientState, "client state", 128),
      latestSupportedTlsVersion: "v1_2",
    }),
  }, { fetchImpl });

  if (!response.ok) {
    throw new MicrosoftMailGraphError("subscription_create_failed", { httpStatus: response.status });
  }
  const body = await readJson(response);
  if (typeof body?.id !== "string" || !body.id
    || body?.resource !== "me/mailFolders('Inbox')/messages"
    || typeof body?.expirationDateTime !== "string") {
    throw new MicrosoftMailGraphError("subscription_create_failed", { httpStatus: response.status });
  }
  const expiresAt = new Date(body.expirationDateTime);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new MicrosoftMailGraphError("subscription_create_failed", { httpStatus: response.status });
  }
  return {
    subscriptionId: body.id,
    resource: body.resource,
    expiresAt,
  };
}

export async function renewMicrosoftMailSubscription({
  accessToken,
  subscriptionId,
  expirationDateTime,
  fetchImpl = fetch,
}) {
  requireDate(expirationDateTime, "expiration");
  const id = encodeURIComponent(requireText(subscriptionId, "subscription ID", 300));
  const response = await graphFetch(`${GRAPH_V1}/subscriptions/${id}`, {
    method: "PATCH",
    headers: {
      ...bearer(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ expirationDateTime: expirationDateTime.toISOString() }),
  }, { fetchImpl });

  if (!response.ok) {
    throw new MicrosoftMailGraphError("subscription_renew_failed", { httpStatus: response.status });
  }
  const body = await readJson(response);
  if (body?.id !== subscriptionId || typeof body?.expirationDateTime !== "string") {
    throw new MicrosoftMailGraphError("subscription_renew_failed", { httpStatus: response.status });
  }
  const expiresAt = new Date(body.expirationDateTime);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new MicrosoftMailGraphError("subscription_renew_failed", { httpStatus: response.status });
  }
  return { subscriptionId: body.id, expiresAt };
}

export async function deleteMicrosoftMailSubscription({
  accessToken,
  subscriptionId,
  fetchImpl = fetch,
}) {
  const id = encodeURIComponent(requireText(subscriptionId, "subscription ID", 300));
  const response = await graphFetch(`${GRAPH_V1}/subscriptions/${id}`, {
    method: "DELETE",
    headers: bearer(accessToken),
  }, { fetchImpl });

  if (![204, 404, 410].includes(response.status)) {
    throw new MicrosoftMailGraphError("subscription_delete_failed", { httpStatus: response.status });
  }
  return true;
}

export async function fetchMicrosoftMailMessage({
  accessToken,
  messageId,
  fetchImpl = fetch,
}) {
  const id = encodeURIComponent(requireText(messageId, "message ID", 1000));
  const url = new URL(`${GRAPH_V1}/me/messages/${id}`);
  url.searchParams.set(
    "$select",
    "id,conversationId,internetMessageId,subject,body,bodyPreview,receivedDateTime,from,replyTo,toRecipients,isDraft",
  );

  const response = await graphFetch(url, {
    method: "GET",
    headers: {
      ...bearer(accessToken),
      Prefer: 'outlook.body-content-type="text"',
    },
  }, { fetchImpl });

  if (!response.ok) {
    throw new MicrosoftMailGraphError("message_fetch_failed", { httpStatus: response.status });
  }
  const body = await readJson(response);
  if (typeof body?.id !== "string" || body.id !== messageId) {
    throw new MicrosoftMailGraphError("message_fetch_failed", { httpStatus: response.status });
  }
  return body;
}
