export const MICROSOFT_AUTHORIZATION_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
export const MICROSOFT_TOKEN_ENDPOINT = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
export const MICROSOFT_GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me";
export const MICROSOFT_MAIL_SCOPES = Object.freeze([
  "openid",
  "profile",
  "offline_access",
  "User.Read",
  "Mail.Read",
]);

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export class MicrosoftMailProviderError extends Error {
  constructor(code, { httpStatus = null } = {}) {
    const messages = {
      denied: "Microsoft mail authorization was denied.",
      exchange_failed: "Microsoft mail authorization exchange failed.",
      invalid_identity: "Microsoft mailbox identity was invalid.",
      temporarily_unavailable: "Microsoft mail is temporarily unavailable.",
    };
    if (!Object.hasOwn(messages, code)) throw new TypeError("Invalid provider error code.");
    super(messages[code]);
    this.name = "MicrosoftMailProviderError";
    this.code = code;
    this.httpStatus = Number.isInteger(httpStatus) ? httpStatus : null;
  }
}

function requireText(value, label, max = 4096) {
  if (typeof value !== "string" || !value || value.length > max) throw new TypeError(`Invalid ${label}.`);
  return value;
}

function requireHttpsOrigin(value) {
  const url = new URL(requireText(value, "public origin"));
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TypeError("Invalid public origin.");
  }
  return url.origin;
}

export function microsoftMailCallbackUri(publicOrigin) {
  return `${requireHttpsOrigin(publicOrigin)}/.netlify/functions/microsoft-mail-oauth-callback`;
}

export function buildMicrosoftMailAuthorizationUrl({
  clientId,
  callbackUri,
  state,
  scopes = MICROSOFT_MAIL_SCOPES,
}) {
  if (!Array.isArray(scopes) || scopes.join(" ") !== MICROSOFT_MAIL_SCOPES.join(" ")) {
    throw new TypeError("Invalid Microsoft mail scopes.");
  }
  const url = new URL(MICROSOFT_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: requireText(clientId, "client ID"),
    response_type: "code",
    redirect_uri: requireText(callbackUri, "callback URI"),
    response_mode: "query",
    scope: scopes.join(" "),
    state: requireText(state, "state"),
    prompt: "select_account",
  }).toString();
  return url.toString();
}

async function readLimitedJson(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error("RESPONSE_TOO_LARGE");
  return JSON.parse(text);
}

async function tokenRequest(body, {
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  let response;
  try {
    response = await fetchImpl(MICROSOFT_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new MicrosoftMailProviderError("temporarily_unavailable");
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new MicrosoftMailProviderError("temporarily_unavailable", { httpStatus: response.status });
    }
    throw new MicrosoftMailProviderError("exchange_failed", { httpStatus: response.status });
  }

  let json;
  try { json = await readLimitedJson(response, maxResponseBytes); }
  catch { throw new MicrosoftMailProviderError("exchange_failed"); }

  if (typeof json?.access_token !== "string" || !json.access_token
    || typeof json?.refresh_token !== "string" || !json.refresh_token
    || !Number.isSafeInteger(json?.expires_in) || json.expires_in <= 0
    || typeof json?.token_type !== "string" || !json.token_type) {
    throw new MicrosoftMailProviderError("exchange_failed");
  }

  const scope = typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [];
  for (const required of ["User.Read", "Mail.Read"]) {
    if (!scope.includes(required)) throw new MicrosoftMailProviderError("exchange_failed");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresInSeconds: json.expires_in,
    tokenType: json.token_type.toLowerCase(),
    scope,
  };
}

export async function exchangeMicrosoftMailAuthorizationCode({
  clientId,
  clientSecret,
  callbackUri,
  code,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  return tokenRequest({
    client_id: requireText(clientId, "client ID"),
    client_secret: requireText(clientSecret, "client secret"),
    code: requireText(code, "authorization code"),
    redirect_uri: requireText(callbackUri, "callback URI"),
    grant_type: "authorization_code",
    scope: MICROSOFT_MAIL_SCOPES.join(" "),
  }, { fetchImpl, maxResponseBytes });
}

export async function refreshMicrosoftMailToken({
  clientId,
  clientSecret,
  refreshToken,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  return tokenRequest({
    client_id: requireText(clientId, "client ID"),
    client_secret: requireText(clientSecret, "client secret"),
    refresh_token: requireText(refreshToken, "refresh token"),
    grant_type: "refresh_token",
    scope: MICROSOFT_MAIL_SCOPES.join(" "),
  }, { fetchImpl, maxResponseBytes });
}

export async function verifyMicrosoftMailboxIdentity({
  accessToken,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  const url = new URL(MICROSOFT_GRAPH_ME_ENDPOINT);
  url.searchParams.set("$select", "id,displayName,mail,userPrincipalName");

  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${requireText(accessToken, "access token")}` },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new MicrosoftMailProviderError("temporarily_unavailable");
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new MicrosoftMailProviderError("temporarily_unavailable", { httpStatus: response.status });
    }
    throw new MicrosoftMailProviderError("invalid_identity", { httpStatus: response.status });
  }

  let json;
  try { json = await readLimitedJson(response, maxResponseBytes); }
  catch { throw new MicrosoftMailProviderError("invalid_identity"); }

  const accountId = typeof json?.id === "string" ? json.id.trim() : "";
  const address = typeof json?.mail === "string" && json.mail.trim()
    ? json.mail.trim().toLowerCase()
    : typeof json?.userPrincipalName === "string" ? json.userPrincipalName.trim().toLowerCase() : "";
  const displayName = typeof json?.displayName === "string" ? json.displayName.trim() : "";

  if (!accountId || !address || !address.includes("@")) {
    throw new MicrosoftMailProviderError("invalid_identity");
  }

  return { accountId, address, displayName: displayName || address };
}

export function configuredMicrosoftMailOAuth({
  env = (name) => globalThis.Netlify?.env?.get(name),
} = {}) {
  const publicOrigin = requireHttpsOrigin(env("GROWTHWISE_PUBLIC_ORIGIN"));
  return Object.freeze({
    clientId: requireText(env("GROWTHWISE_MICROSOFT_CLIENT_ID"), "client ID"),
    clientSecret: requireText(env("GROWTHWISE_MICROSOFT_CLIENT_SECRET"), "client secret"),
    publicOrigin,
    callbackUri: microsoftMailCallbackUri(publicOrigin),
  });
}
