export const INSTAGRAM_AUTHORIZATION_ENDPOINT = "https://www.instagram.com/oauth/authorize";
export const INSTAGRAM_TOKEN_ENDPOINT = "https://api.instagram.com/oauth/access_token";
export const INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT = "https://graph.instagram.com/access_token";
export const INSTAGRAM_REFRESH_TOKEN_ENDPOINT = "https://graph.instagram.com/refresh_access_token";
export const INSTAGRAM_IDENTITY_ENDPOINT = "https://graph.instagram.com/me";
export const INSTAGRAM_IDENTITY_FIELDS = "user_id,username";
export const INSTAGRAM_IDENTITY_SCOPE = "instagram_business_basic";

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export class InstagramProviderError extends Error {
  constructor(code, { httpStatus = null } = {}) {
    const messages = {
      denied: "Instagram authorization was denied.",
      exchange_failed: "Instagram authorization exchange failed.",
      invalid_identity: "Instagram professional identity was invalid.",
      temporarily_unavailable: "Instagram is temporarily unavailable.",
    };
    if (!Object.hasOwn(messages, code)) throw new TypeError("Invalid provider error code.");
    super(messages[code]);
    this.name = "InstagramProviderError";
    this.code = code;
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new TypeError(`Invalid ${label}.`);
  return value;
}

function objectWithRequiredFields(value, required) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

function normalizedProviderId(value) {
  if (typeof value === "string" && value.length > 0 && value === value.trim()) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return undefined;
}

async function providerJson(url, init, { fetchImpl, maxResponseBytes, failureCode }) {
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  } catch {
    throw new InstagramProviderError("temporarily_unavailable");
  }
  // Provider status is authoritative for failure class. Do not parse, buffer,
  // or let an oversized/unreadable raw error body change that classification.
  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new InstagramProviderError("temporarily_unavailable", { httpStatus: response.status });
    }
    throw new InstagramProviderError(failureCode, { httpStatus: response.status });
  }
  let text;
  try { text = await readLimitedText(response, maxResponseBytes); } catch (error) {
    if (error === RESPONSE_TOO_LARGE) throw new InstagramProviderError(failureCode);
    throw new InstagramProviderError("temporarily_unavailable");
  }
  try { return JSON.parse(text); } catch { throw new InstagramProviderError(failureCode); }
}

const RESPONSE_TOO_LARGE = Symbol("response-too-large");

async function readLimitedText(response, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw RESPONSE_TOO_LARGE;
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw RESPONSE_TOO_LARGE;
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        throw RESPONSE_TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function callbackUri(publicOrigin) {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new TypeError("Invalid public origin."); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("Invalid public origin.");
  }
  return `${origin.origin}/.netlify/functions/instagram-oauth-callback`;
}

export function buildAuthorizationUrl({ appId, callbackUri: redirectUri, state }) {
  const url = new URL(INSTAGRAM_AUTHORIZATION_ENDPOINT);
  url.search = new URLSearchParams({
    client_id: requireText(appId, "app ID"),
    redirect_uri: requireText(redirectUri, "callback URI"),
    response_type: "code",
    scope: INSTAGRAM_IDENTITY_SCOPE,
    state: requireText(state, "state"),
  }).toString();
  return url.toString();
}

export function configuredInstagramOAuth({ env = (name) => globalThis.Netlify?.env?.get(name) } = {}) {
  const publicOrigin = requireText(env("GROWTHWISE_PUBLIC_ORIGIN"), "public origin");
  return Object.freeze({
    appId: requireText(env("GROWTHWISE_INSTAGRAM_APP_ID"), "app ID"),
    appSecret: requireText(env("GROWTHWISE_INSTAGRAM_APP_SECRET"), "app secret"),
    publicOrigin,
    callbackUri: callbackUri(publicOrigin),
  });
}

export async function exchangeAuthorizationCode({ appId, appSecret, callbackUri: redirectUri, code, fetchImpl = fetch, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
  const body = new URLSearchParams({ client_id: requireText(appId, "app ID"), client_secret: requireText(appSecret, "app secret"), grant_type: "authorization_code", redirect_uri: requireText(redirectUri, "callback URI"), code: requireText(code, "authorization code") });
  const json = await providerJson(INSTAGRAM_TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() }, { fetchImpl, maxResponseBytes, failureCode: "exchange_failed" });
  const accountId = normalizedProviderId(json?.user_id);
  if (!objectWithRequiredFields(json, ["access_token", "user_id"]) || typeof json.access_token !== "string" || json.access_token.length === 0 || accountId === undefined) {
    throw new InstagramProviderError("exchange_failed");
  }
  return { accessToken: json.access_token, accountId };
}

export async function exchangeLongLivedToken({ appSecret, accessToken, fetchImpl = fetch, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
  const url = new URL(INSTAGRAM_LONG_LIVED_TOKEN_ENDPOINT);
  url.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: requireText(appSecret, "app secret"), access_token: requireText(accessToken, "access token") }).toString();
  const json = await providerJson(url, { method: "GET" }, { fetchImpl, maxResponseBytes, failureCode: "exchange_failed" });
  if (!objectWithRequiredFields(json, ["access_token", "token_type", "expires_in"]) || typeof json.access_token !== "string" || json.access_token.length === 0 || typeof json.token_type !== "string" || json.token_type.length === 0 || !Number.isSafeInteger(json.expires_in) || json.expires_in <= 0) {
    throw new InstagramProviderError("exchange_failed");
  }
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in, tokenType: json.token_type.toLowerCase() };
}

export async function verifyProfessionalIdentity({ accessToken, fetchImpl = fetch, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }) {
  const url = new URL(INSTAGRAM_IDENTITY_ENDPOINT);
  url.searchParams.set("fields", INSTAGRAM_IDENTITY_FIELDS);
  const json = await providerJson(url, { method: "GET", headers: { Authorization: `Bearer ${requireText(accessToken, "access token")}` } }, { fetchImpl, maxResponseBytes, failureCode: "invalid_identity" });
  const accountId = normalizedProviderId(json?.user_id);
  if (!objectWithRequiredFields(json, ["user_id", "username"]) || accountId === undefined || typeof json.username !== "string" || json.username.length === 0) {
    throw new InstagramProviderError("invalid_identity");
  }
  return { accountId, username: json.username, name: json.username };
}
