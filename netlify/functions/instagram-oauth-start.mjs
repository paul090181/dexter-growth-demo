import { timingSafeEqual } from "node:crypto";
import { createInstagramCrypto } from "./_instagram-crypto.mjs";
import { getInstagramClient } from "./_instagram-clients.mjs";
import { buildAuthorizationUrl, callbackUri, INSTAGRAM_AUTHORIZATION_SCOPE } from "./_instagram-oauth.mjs";
import { instagramDatabase } from "./_instagram-store.mjs";

const ENDPOINT_PATH = "/.netlify/functions/instagram-oauth-start";
const MAX_BODY_BYTES = 1024;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

function env(name) { return globalThis.Netlify?.env?.get(name); }
function currentSecret(name) { return { current: { id: "v1", key: env(name) } }; }
function defaultCrypto() {
  return createInstagramCrypto({
    stateSecrets: currentSecret("GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET"),
    bindingSecrets: currentSecret("GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET"),
    credentialKeys: currentSecret("GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

const recentStarts = new Map();
const defaultRateLimiter = {
  consume({ businessId, now }) {
    const previous = recentStarts.get(businessId);
    if (previous && now.getTime() - previous < 30_000) return false;
    recentStarts.set(businessId, now.getTime());
    return true;
  },
};

function safeEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function response(status, message, headers = {}) {
  return new Response(JSON.stringify(message), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    pragma: "no-cache", "referrer-policy": "no-referrer", ...headers,
  } });
}

async function readBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("INVALID_REQUEST");
  const reader = request.body?.getReader();
  const chunks = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new Error("INVALID_REQUEST");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("INVALID_REQUEST"); }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error("INVALID_REQUEST"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "business_id")) throw new Error("INVALID_REQUEST");
  if (typeof body.business_id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)) throw new Error("INVALID_REQUEST");
  return body;
}

function validateAuthorizationUrl(value, { expectedAppId, expectedCallbackUri, expectedState }) {
  let url;
  try { url = new URL(value); } catch { throw new Error("UNSAFE_AUTHORIZATION_URL"); }
  const expected = {
    client_id: expectedAppId,
    redirect_uri: expectedCallbackUri,
    response_type: "code",
    scope: INSTAGRAM_AUTHORIZATION_SCOPE,
    state: expectedState,
  };
  if (url.protocol !== "https:" || url.origin !== "https://www.instagram.com"
    || url.pathname !== "/oauth/authorize" || url.username || url.password || url.hash) {
    throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  const entries = [...url.searchParams];
  if (entries.length !== Object.keys(expected).length) throw new Error("UNSAFE_AUTHORIZATION_URL");
  for (const [key, expectedValue] of Object.entries(expected)) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expectedValue) throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  return url;
}

export function createInstagramOAuthStartHandler(options = {}) {
  const adminKey = options.adminKey ?? (() => env("GROWTHWISE_ADMIN_KEY"));
  const publicOrigin = options.publicOrigin ?? (() => env("GROWTHWISE_PUBLIC_ORIGIN"));
  const appId = options.appId ?? (() => env("GROWTHWISE_INSTAGRAM_APP_ID"));
  const getClient = options.getClient ?? getInstagramClient;
  const buildUrl = options.buildUrl ?? buildAuthorizationUrl;
  const now = options.now ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? defaultRateLimiter;
  return async function instagramOAuthStart(request) {
    const configuredKey = adminKey();
    if (typeof configuredKey !== "string" || configuredKey.length === 0) return response(503, { error: "Instagram connection is not configured." });
    if (!safeEqual(request.headers.get("x-growthwise-key"), configuredKey)) return response(401, { error: "Invalid GrowthWise access code." });
    if (request.method !== "POST") return response(405, { error: "Method not allowed." }, { allow: "POST" });

    let origin;
    try { origin = new URL(publicOrigin()).origin; } catch { return response(503, { error: "Instagram connection is not configured." }); }
    let requestUrl;
    try { requestUrl = new URL(request.url); } catch { return response(403, { error: "Request origin was rejected." }); }
    const fetchSite = request.headers.get("sec-fetch-site");
    if (origin !== publicOrigin() || !origin.startsWith("https://") || request.headers.get("origin") !== origin
      || (fetchSite !== null && fetchSite !== "same-origin") || requestUrl.origin !== origin
      || requestUrl.pathname !== ENDPOINT_PATH || requestUrl.search || requestUrl.hash) {
      return response(403, { error: "Request origin was rejected." });
    }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return response(415, { error: "JSON is required." });

    let body;
    try { body = await readBody(request); } catch { return response(400, { error: "Invalid request." }); }
    let client;
    try { client = getClient(body.business_id); } catch { return response(400, { error: "Invalid request." }); }
    if (!client || client.business_id !== body.business_id || typeof client.returnDestinationId !== "string") return response(400, { error: "Invalid request." });

    const startedAt = now();
    let allowed;
    try { allowed = await rateLimiter.consume({ businessId: body.business_id, now: startedAt }); } catch { allowed = false; }
    if (allowed !== true) return response(429, { error: "Try connecting Instagram again later." });

    try {
      const crypto = options.crypto ?? defaultCrypto();
      const store = options.store ?? instagramDatabase({ crypto });
      const { state } = await store.createTransactionWithFreshState({
        createState: () => crypto.createState(), businessId: body.business_id,
        returnDestinationId: client.returnDestinationId, expiresAt: new Date(startedAt.getTime() + TRANSACTION_TTL_MS),
      });
      const expectedAppId = appId();
      const expectedCallbackUri = callbackUri(origin);
      const authorizationUrl = buildUrl({ appId: expectedAppId, callbackUri: expectedCallbackUri, state });
      const parsed = validateAuthorizationUrl(authorizationUrl, { expectedAppId, expectedCallbackUri, expectedState: state });
      return response(200, { authorization_url: parsed.toString() });
    } catch {
      return response(503, { error: "Instagram connection could not be started." });
    }
  };
}

export default createInstagramOAuthStartHandler();
