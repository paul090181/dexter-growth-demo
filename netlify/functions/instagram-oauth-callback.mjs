import { createInstagramCrypto } from "./_instagram-crypto.mjs";
import { getInstagramClient, getInstagramConnectorClient, resolveInstagramReturnDestination } from "./_instagram-clients.mjs";
import {
  configuredInstagramOAuth, exchangeAuthorizationCode, exchangeLongLivedToken,
  verifyProfessionalIdentity,
} from "./_instagram-oauth.mjs";
import { instagramDatabase } from "./_instagram-store.mjs";

const PATH = "/.netlify/functions/instagram-oauth-callback";
const MAX_QUERY_BYTES = 8192;
const CONNECTOR_DESTINATION = "connector-customer-integration";
const DESTINATIONS = new Set(["growthwise-dev-integration", "dexter-integration", CONNECTOR_DESTINATION]);

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }
function defaultCrypto() {
  return createInstagramCrypto({
    stateSecrets: versions("GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

const safeHeaders = { "cache-control": "no-store", pragma: "no-cache", "referrer-policy": "no-referrer" };
function plain(status) {
  return new Response("Instagram connection could not be completed.", {
    status, headers: { ...safeHeaders, "content-type": "text/plain; charset=utf-8" },
  });
}
function redirect(location) { return new Response(null, { status: 303, headers: { ...safeHeaders, location } }); }

function parseCallback(request) {
  if (request.method !== "GET") throw new Error("INVALID_CALLBACK");
  const rawQuery = request.url.slice(request.url.indexOf("?") + 1);
  if (/%(?![0-9A-Fa-f]{2})/.test(rawQuery)) throw new Error("INVALID_CALLBACK");
  try { decodeURIComponent(rawQuery); } catch { throw new Error("INVALID_CALLBACK"); }
  const url = new URL(request.url);
  if (url.pathname !== PATH || url.hash || Buffer.byteLength(url.search, "utf8") > MAX_QUERY_BYTES) throw new Error("INVALID_CALLBACK");
  const entries = [...url.searchParams];
  if (entries.some(([key, value]) => !key || !value) || new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error("INVALID_CALLBACK");
  const keys = new Set(entries.map(([key]) => key));
  const success = keys.size === 2 && keys.has("state") && keys.has("code");
  const denialAllowed = new Set(["state", "error", "error_reason", "error_description"]);
  const denial = keys.has("state") && keys.has("error") && url.searchParams.get("error") === "access_denied"
    && [...keys].every((key) => denialAllowed.has(key));
  if (!success && !denial) throw new Error("INVALID_CALLBACK");
  return { url, state: url.searchParams.get("state"), code: success ? url.searchParams.get("code") : null, denied: denial };
}

export function createInstagramOAuthCallbackHandler(options = {}) {
  const now = options.now ?? (() => new Date());
  const config = options.config ?? (() => configuredInstagramOAuth());
  const resolveDestination = options.resolveDestination ?? resolveInstagramReturnDestination;
  const exchangeCode = options.exchangeCode ?? exchangeAuthorizationCode;
  const exchangeLongLived = options.exchangeLongLived ?? exchangeLongLivedToken;
  const verifyIdentity = options.verifyIdentity ?? verifyProfessionalIdentity;
  const logger = options.logger ?? console;
  const safeWarn = (stage, providerStatus = null, providerReason = null) => {
    try {
      const details = { stage };
      if (Number.isInteger(providerStatus) && providerStatus >= 100 && providerStatus <= 599) details.provider_status = providerStatus;
      const safeReasons = new Set(["network_error", "http_error", "response_too_large", "response_read_error", "invalid_json", "missing_fields", "local_exception"]);
      if (safeReasons.has(providerReason)) details.provider_reason = providerReason;
      logger.warn("instagram_oauth_callback_failed", details);
    } catch { /* logging cannot alter OAuth control flow */ }
  };
  return async function instagramOAuthCallback(request) {
    let input;
    try { input = parseCallback(request); } catch { safeWarn("parse_callback"); return plain(400); }

    let crypto;
    let transactionKey;
    let settings;
    try {
      crypto = options.crypto ?? defaultCrypto();
      transactionKey = crypto.transactionKey(input.state);
      settings = config();
      const canonical = new URL(settings.publicOrigin);
      if (canonical.protocol !== "https:" || canonical.origin !== settings.publicOrigin
        || canonical.pathname !== "/" || canonical.search || canonical.hash
        || input.url.username || input.url.password
        || input.url.origin !== canonical.origin || input.url.pathname !== PATH) throw new Error("INVALID_ORIGIN");
    } catch { safeWarn("state_or_config"); return plain(400); }
    const store = options.store ?? instagramDatabase({ crypto });
    let transaction;
    try { transaction = await store.claimTransaction({ transactionKey }); } catch { safeWarn("transaction_claim"); return plain(400); }
    if (!transaction) { safeWarn("transaction_missing_or_replayed"); return plain(400); }
    if (!DESTINATIONS.has(transaction.return_destination_id)) {
      try { await store.finishTransaction({ transactionKey, status: "consumed_failed", now: now() }); } catch { /* fail closed */ }
      safeWarn("invalid_return_destination");
      return plain(400);
    }

    const destination = (hint) => resolveDestination({
      destinationId: transaction.return_destination_id, hint, publicOrigin: settings.publicOrigin,
    });
    if (input.denied) {
      try {
        await store.finishTransaction({ transactionKey, status: "consumed_denied", now: now() });
        return redirect(destination("cancelled"));
      } catch { safeWarn("denial_finalize"); return plain(500); }
    }

    let failureStage = "provider_code_exchange";
    try {
      const short = await exchangeCode({ ...settings, code: input.code });
      failureStage = "provider_long_lived_exchange";
      const long = await exchangeLongLived({ appSecret: settings.appSecret, accessToken: short.accessToken });
      failureStage = "provider_identity_verify";
      const identity = await verifyIdentity({ accessToken: long.accessToken });
      if (!identity || typeof identity.accountId !== "string" || !identity.accountId
        || typeof identity.username !== "string" || !identity.username) {
        throw new Error("INVALID_IDENTITY");
      }
      const expiresAt = new Date(now().getTime() + long.expiresInSeconds * 1000);
      const client = transaction.return_destination_id === CONNECTOR_DESTINATION
        ? getInstagramConnectorClient(transaction.business_id)
        : getInstagramClient(transaction.business_id);
      failureStage = "credential_store";
      await store.connectCredential({
        businessId: transaction.business_id, accountId: identity.accountId,
        payload: {
          access_token: long.accessToken, account_id: identity.accountId,
          token_type: long.tokenType, scope: client.authorizationScope,
        },
        status: "active", tokenExpiresAt: expiresAt, username: identity.username,
        displayName: identity.name ?? identity.username, lastVerifiedAt: now(),
        transactionKey, consumedAt: now(),
      });
      return redirect(destination("connected"));
    } catch (error) {
      safeWarn(failureStage, error?.httpStatus, error?.reason ?? "local_exception");
      try {
        await store.finishTransaction({ transactionKey, status: "consumed_failed", now: now() });
        return redirect(destination("attention"));
      } catch { safeWarn("failure_finalize"); return plain(500); }
    }
  };
}

export default createInstagramOAuthCallbackHandler();
