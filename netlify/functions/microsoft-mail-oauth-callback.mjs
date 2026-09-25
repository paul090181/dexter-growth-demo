import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";
import {
  configuredMicrosoftMailOAuth,
  exchangeMicrosoftMailAuthorizationCode,
  verifyMicrosoftMailboxIdentity,
} from "./_microsoft-mail-oauth.mjs";
import { createAndStoreMicrosoftMailSubscription } from "./_microsoft-mail-subscriptions.mjs";

const PATH = "/.netlify/functions/microsoft-mail-oauth-callback";
const MAX_QUERY_BYTES = 8192;
const SAFE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function plain(status) {
  return new Response("Microsoft email connection could not be completed.", {
    status,
    headers: { ...SAFE_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

function redirect(origin, hint) {
  const target = new URL("/connect-accounts.html", origin);
  target.searchParams.set("email", hint);
  return new Response(null, {
    status: 303,
    headers: { ...SAFE_HEADERS, location: target.toString() },
  });
}

function parseCallback(request) {
  if (request.method !== "GET") throw new Error("INVALID_CALLBACK");
  const url = new URL(request.url);
  if (url.pathname !== PATH || url.hash || Buffer.byteLength(url.search, "utf8") > MAX_QUERY_BYTES) {
    throw new Error("INVALID_CALLBACK");
  }
  const entries = [...url.searchParams];
  if (entries.some(([key, value]) => !key || !value)
    || new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new Error("INVALID_CALLBACK");
  }

  const keys = new Set(entries.map(([key]) => key));
  const successAllowed = new Set(["state", "code", "session_state"]);
  const success = keys.has("state")
    && keys.has("code")
    && [...keys].every((key) => successAllowed.has(key));

  const denialAllowed = new Set([
    "state", "error", "error_description", "error_uri", "error_codes",
    "timestamp", "trace_id", "correlation_id", "session_state",
  ]);
  const denial = keys.has("state")
    && url.searchParams.get("error") === "access_denied"
    && [...keys].every((key) => denialAllowed.has(key));

  if (!success && !denial) throw new Error("INVALID_CALLBACK");

  return {
    url,
    state: url.searchParams.get("state"),
    code: success ? url.searchParams.get("code") : null,
    denied: denial,
  };
}

export function createMicrosoftMailOAuthCallbackHandler(options = {}) {
  const now = options.now ?? (() => new Date());
  const config = options.config ?? (() => configuredMicrosoftMailOAuth());
  const exchangeCode = options.exchangeCode ?? exchangeMicrosoftMailAuthorizationCode;
  const verifyIdentity = options.verifyIdentity ?? verifyMicrosoftMailboxIdentity;
  const createSubscription = options.createSubscription ?? createAndStoreMicrosoftMailSubscription;
  const logger = options.logger ?? console;

  const safeWarn = (stage, providerStatus = null) => {
    try {
      const details = { stage };
      if (Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599) {
        details.provider_status = providerStatus;
      }
      logger.warn("microsoft_mail_oauth_callback_failed", details);
    } catch {}
  };

  return async function microsoftMailOAuthCallback(request) {
    let input;
    try { input = parseCallback(request); }
    catch {
      safeWarn("parse_callback");
      return plain(400);
    }

    let settings;
    let crypto;
    let transactionKey;
    try {
      settings = config();
      const canonical = new URL(settings.publicOrigin);
      if (canonical.protocol !== "https:"
        || canonical.origin !== settings.publicOrigin
        || canonical.pathname !== "/"
        || canonical.search
        || canonical.hash
        || input.url.origin !== canonical.origin
        || input.url.pathname !== PATH
        || input.url.username
        || input.url.password) {
        throw new Error("INVALID_ORIGIN");
      }
      crypto = options.crypto ?? defaultCrypto();
      transactionKey = crypto.transactionKey(input.state);
    } catch {
      safeWarn("state_or_config");
      return plain(400);
    }

    const store = options.store ?? createMicrosoftMailStore({ crypto });
    let transaction;
    try { transaction = await store.claimTransaction({ transactionKey }); }
    catch {
      safeWarn("transaction_claim");
      return plain(400);
    }
    if (!transaction) {
      safeWarn("transaction_missing_or_replayed");
      return plain(400);
    }

    if (input.denied) {
      try {
        await store.finishTransaction({
          transactionKey,
          status: "consumed_denied",
          now: now(),
        });
        return redirect(settings.publicOrigin, "cancelled");
      } catch {
        safeWarn("denial_finalize");
        return plain(500);
      }
    }

    let stage = "provider_code_exchange";
    let credentialStored = false;
    try {
      const token = await exchangeCode({
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
        callbackUri: settings.callbackUri,
        code: input.code,
      });

      stage = "provider_identity_verify";
      const identity = await verifyIdentity({ accessToken: token.accessToken });
      if (!identity
        || typeof identity.accountId !== "string"
        || !identity.accountId
        || typeof identity.address !== "string"
        || !identity.address.includes("@")) {
        throw new Error("INVALID_IDENTITY");
      }

      const verifiedAt = now();
      stage = "credential_store";
      await store.connectCredential({
        businessId: transaction.business_id,
        accountId: identity.accountId,
        payload: {
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          token_type: token.tokenType,
          scope: token.scope,
          account_id: identity.accountId,
        },
        status: "active",
        tokenExpiresAt: new Date(verifiedAt.getTime() + token.expiresInSeconds * 1000),
        emailAddress: identity.address,
        displayName: identity.displayName,
        mailboxContext: transaction.mailbox_context,
        consentRecordedAt: new Date(transaction.created_at),
        lastVerifiedAt: verifiedAt,
        transactionKey,
        consumedAt: verifiedAt,
      });
      credentialStored = true;

      stage = "subscription_create";
      await createSubscription({
        businessId: transaction.business_id,
        accessToken: token.accessToken,
        publicOrigin: settings.publicOrigin,
        store,
        now: verifiedAt,
      });

      return redirect(settings.publicOrigin, "connected");
    } catch (error) {
      safeWarn(stage, error?.httpStatus);
      if (credentialStored) {
        try {
          await store.markCredentialStatus({
            businessId: transaction.business_id,
            status: "needs_attention",
          });
        } catch {}
        return redirect(settings.publicOrigin, "attention");
      }
      try {
        await store.finishTransaction({
          transactionKey,
          status: "consumed_failed",
          now: now(),
        });
        return redirect(settings.publicOrigin, "attention");
      } catch {
        safeWarn("failure_finalize");
        return plain(500);
      }
    }
  };
}

export default createMicrosoftMailOAuthCallbackHandler();
