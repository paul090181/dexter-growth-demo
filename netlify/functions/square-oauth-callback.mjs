import { createSquareCrypto } from "./_square-crypto.mjs";
import { squareCryptoVersion } from "./_square-preview-secrets.mjs";
import { squareOAuthConfigForRequest } from "./_square-oauth-config.mjs";
import {
  SQUARE_OAUTH_SCOPES,
  exchangeSquareAuthorizationCode,
  retrieveSquareMerchant,
  retrieveSquareTokenStatus,
} from "./_square-oauth.mjs";
import { createSquareStore } from "./_square-store.mjs";

const PATH = "/.netlify/functions/square-oauth-callback";
const MAX_QUERY_BYTES = 8192;
const SAFE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function env(name) { return globalThis.Netlify?.env?.get(name); }

function defaultCrypto() {
  return createSquareCrypto({
    stateSecrets: squareCryptoVersion("GROWTHWISE_SQUARE_OAUTH_STATE_SECRET"),
    bindingSecrets: squareCryptoVersion("GROWTHWISE_SQUARE_ACCOUNT_BINDING_SECRET"),
    credentialKeys: squareCryptoVersion("GROWTHWISE_SQUARE_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function config(requestUrl) {
  return squareOAuthConfigForRequest(requestUrl, { env });
}

function plain(status) {
  return new Response("Square connection could not be completed.", {
    status,
    headers: { ...SAFE_HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

function redirect(origin, hint, businessId = "") {
  const isAcceptance = /^gw-square-accept-a-[a-f0-9]{10}$/.test(businessId);
  const target = new URL(
    isAcceptance
      ? "/.netlify/functions/preview16-square-acceptance"
      : "/app.html",
    origin,
  );
  if (isAcceptance) target.searchParams.set("browser", "finish");
  else target.searchParams.set("square", hint);
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
  const success = keys.size === 2 && keys.has("state") && keys.has("code");
  const denialAllowed = new Set(["state", "error", "error_description"]);
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

export function createSquareOAuthCallbackHandler(options = {}) {
  const now = options.now ?? (() => new Date());
  const getConfig = options.config ?? config;
  const exchangeCode = options.exchangeCode ?? exchangeSquareAuthorizationCode;
  const tokenStatus = options.tokenStatus ?? retrieveSquareTokenStatus;
  const merchantDetails = options.merchantDetails ?? retrieveSquareMerchant;
  const logger = options.logger ?? console;

  const safeWarn = (stage, providerStatus = null) => {
    try {
      const details = { stage };
      if (Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599) {
        details.provider_status = providerStatus;
      }
      logger.warn("square_oauth_callback_failed", details);
    } catch {}
  };

  return async function squareOAuthCallback(request) {
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
      settings = getConfig(input.url);
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
      if (settings.environment === "production"
        && /(^|\.)deploy-preview-\d+--/.test(canonical.hostname)) {
        throw new Error("PRODUCTION_PREVIEW_FORBIDDEN");
      }
      crypto = options.crypto ?? defaultCrypto();
      transactionKey = crypto.transactionKey(input.state);
    } catch {
      safeWarn("state_or_config");
      return plain(400);
    }

    const store = options.store ?? createSquareStore({ crypto });
    let transaction;
    try { transaction = await store.claimTransaction({ transactionKey }); }
    catch {
      safeWarn("transaction_claim");
      return plain(400);
    }

    if (!transaction || transaction.environment !== settings.environment) {
      safeWarn("transaction_missing_replayed_or_environment_mismatch");
      return plain(400);
    }

    if (input.denied) {
      try {
        await store.finishTransaction({
          transactionKey,
          status: "consumed_denied",
          now: now(),
        });
        return redirect(settings.publicOrigin, "cancelled", transaction.business_id);
      } catch {
        safeWarn("denial_finalize");
        return plain(500);
      }
    }

    let stage = "provider_code_exchange";
    try {
      const token = await exchangeCode({
        applicationId: settings.applicationId,
        applicationSecret: settings.applicationSecret,
        environment: settings.environment,
        code: input.code,
      });

      stage = "provider_token_verify";
      const status = await tokenStatus({
        accessToken: token.accessToken,
        environment: settings.environment,
      });

      if (status.merchantId !== token.merchantId
        || SQUARE_OAUTH_SCOPES.some((scope) => !status.scopes.includes(scope))) {
        throw new Error("SQUARE_SCOPE_OR_MERCHANT_MISMATCH");
      }

      stage = "provider_merchant_verify";
      const merchant = await merchantDetails({
        accessToken: token.accessToken,
        merchantId: token.merchantId,
        environment: settings.environment,
      });

      if (!merchant || merchant.merchantId !== token.merchantId) {
        throw new Error("INVALID_MERCHANT");
      }

      const verifiedAt = now();
      stage = "credential_store";
      await store.connectCredential({
        businessId: transaction.business_id,
        accountId: token.merchantId,
        environment: settings.environment,
        payload: {
          access_token: token.accessToken,
          refresh_token: token.refreshToken,
          token_type: token.tokenType,
          merchant_id: token.merchantId,
          scopes: [...status.scopes],
        },
        status: "active",
        tokenExpiresAt: token.expiresAt,
        displayName: merchant.displayName,
        lastVerifiedAt: verifiedAt,
        transactionKey,
        consumedAt: verifiedAt,
      });

      return redirect(settings.publicOrigin, "connected", transaction.business_id);
    } catch (error) {
      safeWarn(stage, error?.httpStatus);
      try {
        await store.finishTransaction({
          transactionKey,
          status: "consumed_failed",
          now: now(),
        });
        return redirect(settings.publicOrigin, "attention", transaction.business_id);
      } catch {
        safeWarn("failure_finalize");
        return plain(500);
      }
    }
  };
}

export default createSquareOAuthCallbackHandler();
