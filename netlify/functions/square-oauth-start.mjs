import { authorizeTenantSquareRequest } from "./_tenant-square-auth.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createSquareCrypto } from "./_square-crypto.mjs";
import {
  SQUARE_OAUTH_SCOPES,
  buildSquareAuthorizationUrl,
  configuredSquareOAuth,
} from "./_square-oauth.mjs";
import { createSquareStore } from "./_square-store.mjs";

const PATH = "/.netlify/functions/square-oauth-start";
const MAX_BODY_BYTES = 1024;
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createSquareCrypto({
    stateSecrets: versions("GROWTHWISE_SQUARE_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_SQUARE_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_SQUARE_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function config() {
  const publicOrigin = resolveGrowthWisePublicOrigin((name) => env(name) || "");
  if (!publicOrigin) throw new Error("INVALID_ORIGIN");
  return configuredSquareOAuth({ env, publicOrigin });
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

function json(status, body, { allow = null } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
  };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

async function readBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null
    && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error("INVALID_REQUEST");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("INVALID_REQUEST");
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error("INVALID_REQUEST"); }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1
    || typeof body.business_id !== "string"
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)
    || body.business_id.length > 80) {
    throw new Error("INVALID_REQUEST");
  }
  return body;
}

function validateAuthorizationUrl(value, settings, state) {
  const url = new URL(value);
  const expectedOrigin = settings.environment === "sandbox"
    ? "https://connect.squareupsandbox.com"
    : "https://connect.squareup.com";
  if (url.protocol !== "https:"
    || url.origin !== expectedOrigin
    || url.pathname !== "/oauth2/authorize"
    || url.username
    || url.password
    || url.hash) {
    throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  const required = {
    client_id: settings.applicationId,
    scope: SQUARE_OAUTH_SCOPES.join(" "),
    session: "false",
    state,
  };
  if ([...url.searchParams].length !== Object.keys(required).length) {
    throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  for (const [key, expected] of Object.entries(required)) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== expected) {
      throw new Error("UNSAFE_AUTHORIZATION_URL");
    }
  }
  return url;
}

export function createSquareOAuthStartHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantSquareRequest;
  const now = options.now ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? defaultRateLimiter;
  const getConfig = options.config ?? config;

  return async function squareOAuthStart(request) {
    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed." }, { allow: "POST" });
    }

    let settings;
    let requestUrl;
    try {
      settings = getConfig();
      requestUrl = new URL(request.url);
    } catch {
      return json(503, { error: "Square connection is not configured." });
    }

    const fetchSite = request.headers.get("sec-fetch-site");
    if (requestUrl.origin !== settings.publicOrigin
      || requestUrl.pathname !== PATH
      || requestUrl.search
      || requestUrl.hash
      || request.headers.get("origin") !== settings.publicOrigin
      || (fetchSite !== null && fetchSite !== "same-origin")) {
      return json(403, { error: "Request origin was rejected." });
    }

    if (settings.environment === "production"
      && /(^|\.)deploy-preview-\d+--/.test(new URL(settings.publicOrigin).hostname)) {
      return json(503, { error: "Square connection is not configured." });
    }

    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      !== "application/json") {
      return json(415, { error: "JSON is required." });
    }

    let body;
    try { body = await readBody(request); }
    catch { return json(400, { error: "Invalid request." }); }

    const auth = await authorize(request, { businessId: body.business_id });
    if (!auth?.ok || auth.businessId !== body.business_id) {
      if (auth?.via === "locked") {
        return json(403, { error: "Inventory connection is not included in this plan." });
      }
      if (auth?.via === "unavailable") {
        return json(503, { error: "Business account is temporarily unavailable." });
      }
      return json(401, { error: "Tenant credentials are invalid." });
    }

    const startedAt = now();
    let allowed = false;
    try { allowed = await rateLimiter.consume({ businessId: body.business_id, now: startedAt }); }
    catch {}
    if (!allowed) return json(429, { error: "Try connecting Square again later." });

    try {
      const crypto = options.crypto ?? defaultCrypto();
      const store = options.store ?? createSquareStore({ crypto });
      const { state } = await store.createTransactionWithFreshState({
        createState: () => crypto.createState(),
        businessId: body.business_id,
        environment: settings.environment,
        expiresAt: new Date(startedAt.getTime() + TRANSACTION_TTL_MS),
      });
      const authorizationUrl = (options.buildUrl ?? buildSquareAuthorizationUrl)({
        applicationId: settings.applicationId,
        environment: settings.environment,
        state,
        scopes: SQUARE_OAUTH_SCOPES,
      });
      const safe = validateAuthorizationUrl(authorizationUrl, settings, state);
      return json(200, { authorization_url: safe.toString() });
    } catch {
      return json(503, { error: "Square connection could not be started." });
    }
  };
}

export default createSquareOAuthStartHandler();
