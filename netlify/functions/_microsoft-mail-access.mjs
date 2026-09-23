import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";
import {
  configuredMicrosoftMailOAuth,
  refreshMicrosoftMailToken,
} from "./_microsoft-mail-oauth.mjs";

const REFRESH_SAFETY_MS = 5 * 60 * 1000;

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export class MicrosoftMailAccessError extends Error {
  constructor(code) {
    super(code);
    this.name = "MicrosoftMailAccessError";
    this.code = code;
  }
}

export async function getMicrosoftMailAccess({
  businessId,
  now = new Date(),
  crypto = defaultCrypto(),
  store = createMicrosoftMailStore({ crypto }),
  config = configuredMicrosoftMailOAuth(),
  refreshToken = refreshMicrosoftMailToken,
} = {}) {
  if (typeof businessId !== "string" || !businessId
    || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new MicrosoftMailAccessError("invalid_request");
  }

  let credential;
  try {
    credential = await store.readDecryptedCredential({ businessId });
  } catch {
    throw new MicrosoftMailAccessError("credential_unavailable");
  }

  if (!credential || credential.status !== "active"
    || typeof credential.payload?.account_id !== "string"
    || typeof credential.payload?.access_token !== "string"
    || typeof credential.payload?.refresh_token !== "string") {
    throw new MicrosoftMailAccessError("credential_unavailable");
  }

  const expiresAt = new Date(credential.token_expires_at);
  if (Number.isFinite(expiresAt.getTime())
    && expiresAt.getTime() > now.getTime() + REFRESH_SAFETY_MS) {
    return {
      accessToken: credential.payload.access_token,
      credential,
      refreshed: false,
    };
  }

  try {
    const refreshed = await refreshToken({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: credential.payload.refresh_token,
    });
    const tokenExpiresAt = new Date(now.getTime() + refreshed.expiresInSeconds * 1000);
    const payload = {
      ...credential.payload,
      access_token: refreshed.accessToken,
      refresh_token: refreshed.refreshToken,
      token_type: refreshed.tokenType,
      scope: refreshed.scope,
    };

    await store.updateCredentialToken({
      businessId,
      accountId: credential.payload.account_id,
      payload,
      tokenExpiresAt,
      now,
    });

    return {
      accessToken: refreshed.accessToken,
      credential: {
        ...credential,
        payload,
        token_expires_at: tokenExpiresAt,
        status: "active",
      },
      refreshed: true,
    };
  } catch {
    try {
      await store.markCredentialStatus({ businessId, status: "needs_attention" });
    } catch {}
    throw new MicrosoftMailAccessError("refresh_failed");
  }
}
