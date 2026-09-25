export const SQUARE_API_VERSION = "2026-09-16";
export const SQUARE_OAUTH_SCOPES = Object.freeze([
  "MERCHANT_PROFILE_READ",
  "ITEMS_READ",
  "INVENTORY_READ",
  "ORDERS_READ",
]);

const ENVIRONMENTS = Object.freeze({
  sandbox: {
    oauthBase: "https://connect.squareupsandbox.com/oauth2",
    apiBase: "https://connect.squareupsandbox.com",
  },
  production: {
    oauthBase: "https://connect.squareup.com/oauth2",
    apiBase: "https://connect.squareup.com",
  },
});

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const RESPONSE_TOO_LARGE = Symbol("response-too-large");

export class SquareOAuthProviderError extends Error {
  constructor(code, { httpStatus = null } = {}) {
    const messages = {
      exchange_failed: "Square authorization exchange failed.",
      invalid_token: "Square access token could not be verified.",
      invalid_merchant: "Square merchant identity could not be verified.",
      temporarily_unavailable: "Square is temporarily unavailable.",
    };
    if (!Object.hasOwn(messages, code)) throw new TypeError("Invalid provider error code.");
    super(messages[code]);
    this.name = "SquareOAuthProviderError";
    this.code = code;
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599
      ? httpStatus
      : null;
  }
}

function requireText(value, label, max = 4096) {
  if (typeof value !== "string" || !value || value.length > max) {
    throw new TypeError(`Invalid ${label}.`);
  }
  return value;
}

function environmentSettings(environment) {
  const settings = ENVIRONMENTS[environment];
  if (!settings) throw new TypeError("Invalid Square environment.");
  return settings;
}

function parseJson(text, failureCode) {
  try { return JSON.parse(text); }
  catch { throw new SquareOAuthProviderError(failureCode); }
}

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
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function providerJson(url, init, {
  fetchImpl,
  maxResponseBytes,
  failureCode,
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch {
    throw new SquareOAuthProviderError("temporarily_unavailable");
  }

  if (!response.ok) {
    if (response.status === 429 || response.status >= 500) {
      throw new SquareOAuthProviderError("temporarily_unavailable", {
        httpStatus: response.status,
      });
    }
    throw new SquareOAuthProviderError(failureCode, { httpStatus: response.status });
  }

  let text;
  try {
    text = await readLimitedText(response, maxResponseBytes);
  } catch {
    throw new SquareOAuthProviderError("temporarily_unavailable");
  }
  return parseJson(text, failureCode);
}

export function squareCallbackUri(publicOrigin) {
  let origin;
  try { origin = new URL(publicOrigin); }
  catch { throw new TypeError("Invalid public origin."); }
  if (origin.protocol !== "https:"
    || origin.origin !== publicOrigin
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.username
    || origin.password) {
    throw new TypeError("Invalid public origin.");
  }
  return `${origin.origin}/.netlify/functions/square-oauth-callback`;
}

export function configuredSquareOAuth({
  env = (name) => globalThis.Netlify?.env?.get(name),
  publicOrigin = null,
} = {}) {
  const environment = requireText(env("GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT"), "environment", 20);
  const endpoints = environmentSettings(environment);
  const origin = requireText(publicOrigin, "public origin");
  return Object.freeze({
    environment,
    applicationId: requireText(env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_ID"), "application ID", 300),
    applicationSecret: requireText(env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET"), "application secret", 500),
    publicOrigin: origin,
    callbackUri: squareCallbackUri(origin),
    ...endpoints,
  });
}

export function buildSquareAuthorizationUrl({
  applicationId,
  environment,
  state,
  scopes = SQUARE_OAUTH_SCOPES,
} = {}) {
  const { oauthBase } = environmentSettings(environment);
  if (!Array.isArray(scopes)
    || scopes.length === 0
    || scopes.some((scope) => !SQUARE_OAUTH_SCOPES.includes(scope))) {
    throw new TypeError("Invalid Square OAuth scopes.");
  }
  const url = new URL(`${oauthBase}/authorize`);
  url.search = new URLSearchParams({
    client_id: requireText(applicationId, "application ID", 300),
    scope: scopes.join(" "),
    session: "false",
    state: requireText(state, "state", 4096),
  }).toString();
  return url.toString();
}

export async function exchangeSquareAuthorizationCode({
  applicationId,
  applicationSecret,
  environment,
  code,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const { oauthBase } = environmentSettings(environment);
  const json = await providerJson(`${oauthBase}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
    body: JSON.stringify({
      client_id: requireText(applicationId, "application ID", 300),
      client_secret: requireText(applicationSecret, "application secret", 500),
      code: requireText(code, "authorization code", 512),
      grant_type: "authorization_code",
    }),
  }, { fetchImpl, maxResponseBytes, failureCode: "exchange_failed" });

  if (typeof json?.access_token !== "string" || !json.access_token
    || typeof json?.refresh_token !== "string" || !json.refresh_token
    || typeof json?.merchant_id !== "string" || !json.merchant_id
    || typeof json?.token_type !== "string" || json.token_type.toLowerCase() !== "bearer"
    || typeof json?.expires_at !== "string"
    || !Number.isFinite(new Date(json.expires_at).getTime())) {
    throw new SquareOAuthProviderError("exchange_failed");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    merchantId: json.merchant_id,
    tokenType: "bearer",
    expiresAt: new Date(json.expires_at),
  };
}

export async function retrieveSquareTokenStatus({
  accessToken,
  environment,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const { oauthBase } = environmentSettings(environment);
  const json = await providerJson(`${oauthBase}/token/status`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${requireText(accessToken, "access token", 2048)}`,
      "content-type": "application/json",
      "Square-Version": SQUARE_API_VERSION,
    },
  }, { fetchImpl, maxResponseBytes, failureCode: "invalid_token" });

  if (typeof json?.merchant_id !== "string" || !json.merchant_id
    || !Array.isArray(json?.scopes)
    || json.scopes.some((scope) => typeof scope !== "string")) {
    throw new SquareOAuthProviderError("invalid_token");
  }

  return {
    merchantId: json.merchant_id,
    scopes: [...json.scopes],
    expiresAt: typeof json.expires_at === "string" && Number.isFinite(new Date(json.expires_at).getTime())
      ? new Date(json.expires_at)
      : null,
  };
}

export async function retrieveSquareMerchant({
  accessToken,
  merchantId,
  environment,
  fetchImpl = fetch,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  const { apiBase } = environmentSettings(environment);
  const json = await providerJson(
    `${apiBase}/v2/merchants/${encodeURIComponent(requireText(merchantId, "merchant ID", 300))}`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${requireText(accessToken, "access token", 2048)}`,
        "Square-Version": SQUARE_API_VERSION,
      },
    },
    { fetchImpl, maxResponseBytes, failureCode: "invalid_merchant" },
  );

  if (typeof json?.merchant?.id !== "string" || json.merchant.id !== merchantId) {
    throw new SquareOAuthProviderError("invalid_merchant");
  }

  return {
    merchantId,
    displayName: typeof json.merchant.business_name === "string" && json.merchant.business_name.trim()
      ? json.merchant.business_name.trim()
      : "Square merchant",
  };
}
