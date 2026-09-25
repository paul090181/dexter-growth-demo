import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createSquareCrypto } from "./_square-crypto.mjs";
import {
  SQUARE_OAUTH_SCOPES,
  configuredSquareOAuth,
  refreshSquareAccessToken,
} from "./_square-oauth.mjs";
import { createSquareStore } from "./_square-store.mjs";

const REFRESH_SAFETY_MS = 5 * 60 * 1000;

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createSquareCrypto({
    bindingSecrets: versions("GROWTHWISE_SQUARE_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_SQUARE_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function defaultConfig() {
  const publicOrigin = resolveGrowthWisePublicOrigin((name) => env(name) || "");
  if (!publicOrigin) throw new Error("INVALID_ORIGIN");
  return configuredSquareOAuth({ env, publicOrigin });
}

export class SquareAccessError extends Error {
  constructor(code) {
    super(code);
    this.name = "SquareAccessError";
    this.code = code;
  }
}

export async function getSquareAccess({
  businessId,
  now = new Date(),
  crypto = defaultCrypto(),
  store = createSquareStore({ crypto }),
  config = defaultConfig,
  refreshToken = refreshSquareAccessToken,
} = {}) {
  if (typeof businessId !== "string" || !businessId
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new SquareAccessError("invalid_request");
  }

  let credential;
  try {
    credential = await store.readDecryptedCredential({ businessId });
  } catch {
    throw new SquareAccessError("credential_unavailable");
  }

  if (!credential) throw new SquareAccessError("not_connected");

  const payload = credential.payload;
  if (credential.status !== "active"
    || !["sandbox", "production"].includes(credential.environment)
    || typeof payload?.access_token !== "string" || !payload.access_token
    || typeof payload?.refresh_token !== "string" || !payload.refresh_token
    || typeof payload?.merchant_id !== "string" || !payload.merchant_id
    || !Array.isArray(payload?.scopes)
    || SQUARE_OAUTH_SCOPES.some((scope) => !payload.scopes.includes(scope))) {
    throw new SquareAccessError("needs_attention");
  }

  const expiresAt = new Date(credential.token_expires_at);
  if (Number.isFinite(expiresAt.getTime())
    && expiresAt.getTime() > now.getTime() + REFRESH_SAFETY_MS) {
    return {
      accessToken: payload.access_token,
      merchantId: payload.merchant_id,
      scopes: [...payload.scopes],
      environment: credential.environment,
      refreshed: false,
    };
  }

  try {
    const settings = config();
    if (settings.environment !== credential.environment) {
      throw new Error("ENVIRONMENT_MISMATCH");
    }

    const refreshed = await refreshToken({
      applicationId: settings.applicationId,
      applicationSecret: settings.applicationSecret,
      environment: credential.environment,
      refreshToken: payload.refresh_token,
    });

    if (refreshed.merchantId !== payload.merchant_id) {
      throw new Error("MERCHANT_MISMATCH");
    }

    const nextPayload = {
      ...payload,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_type: refreshed.tokenType,
      merchant_id: refreshed.merchantId,
    };

    await store.updateCredentialToken({
      businessId,
      accountId: payload.merchant_id,
      payload: nextPayload,
      tokenExpiresAt: refreshed.expiresAt,
      now,
    });

    return {
      accessToken: refreshed.accessToken,
      merchantId: refreshed.merchantId,
      scopes: [...payload.scopes],
      environment: credential.environment,
      refreshed: true,
    };
  } catch {
    try {
      await store.markCredentialStatus({
        businessId,
        status: "needs_attention",
        lastVerifiedAt: now,
      });
    } catch {}
    throw new SquareAccessError("refresh_failed");
  }
}
