import growthwiseDev from "../../clients/growthwise-dev.json" with { type: "json" };
import dextersHats from "../../clients/dexters-hats.json" with { type: "json" };
import { createInstagramCrypto } from "./_instagram-crypto.mjs";
import { instagramDatabase } from "./_instagram-store.mjs";
import { INSTAGRAM_CONTENT_PUBLISH_SCOPE, verifyProfessionalIdentity } from "./_instagram-oauth.mjs";

const DEFAULT_CLIENTS = Object.freeze({
  [growthwiseDev.business_id]: growthwiseDev,
  [dextersHats.business_id]: dextersHats,
});
const EXPIRY_SAFETY_MS = 60_000;
const ACTIONS = Object.freeze({
  connect: "An owner must complete the secure Meta authorization flow.",
  reconnect: "Reconnect Instagram so GrowthWise can verify this professional account.",
  retry: "GrowthWise could not verify Meta right now. Try the connection check again.",
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function configuredEnv(name) { return globalThis.Netlify?.env?.get(name); }
function configuredAdminKey() { return configuredEnv("GROWTHWISE_ADMIN_KEY") ?? ""; }
function versions(name) { return { current: { id: "v1", key: configuredEnv(name) } }; }
function defaultCrypto() {
  return createInstagramCrypto({
    stateSecrets: versions("GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"),
  });
}
function defaultLegacyFallback({ businessId, env }) {
  const allowed = (env("GROWTHWISE_INSTAGRAM_LEGACY_FALLBACK_BUSINESSES") ?? "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return allowed.includes(businessId);
}
function statusBody(businessId, state, checkedAt, extra = {}) {
  return { business_id: businessId, state, checked_at: checkedAt, ...extra };
}
function attention(businessId, checkedAt, action = ACTIONS.reconnect) {
  return json(200, statusBody(businessId, "Needs Attention", checkedAt, { action }));
}

export function createInstagramConnectionHandler(options = {}) {
  const adminKey = options.adminKey ?? configuredAdminKey;
  const clients = options.clients ?? DEFAULT_CLIENTS;
  const env = options.env ?? configuredEnv;
  const now = options.now ?? (() => new Date());
  const verifyIdentity = options.verifyIdentity
    ?? ((input) => verifyProfessionalIdentity({ ...input, fetchImpl: options.fetchImpl ?? fetch }));
  const legacyFallbackEnabled = options.legacyFallbackEnabled ?? defaultLegacyFallback;
  const logger = options.logger ?? console;
  const safeWarn = (stage) => {
    try { logger.warn("instagram_connection_health", { stage }); }
    catch { /* logging cannot alter health control flow */ }
  };

  return async function instagramConnectionHandler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed" });
    if (!adminKey() || request.headers.get("x-growthwise-key") !== adminKey()) {
      return json(401, { error: "Invalid GrowthWise access code." });
    }
    const businessId = new URL(request.url).searchParams.get("business_id")?.trim();
    const client = clients[businessId];
    if (!businessId || !client || client.business_id !== businessId) {
      return json(404, { error: "Instagram connection was not found." });
    }

    const checked = now();
    const checkedAt = checked.toISOString();
    let store = options.store;
    try {
      store ??= instagramDatabase();
      const row = await (options.readCredential ?? store.readCredential)({ businessId });
      if (row) {
        safeWarn("credential_found");
        if (row.business_id !== businessId || row.status !== "active") return attention(businessId, checkedAt);
        const expiresAt = new Date(row.token_expires_at);
        if (row.token_expires_at == null || !Number.isFinite(expiresAt.getTime())
          || expiresAt.getTime() <= checked.getTime() + EXPIRY_SAFETY_MS) {
          await (options.updateCredentialHealth ?? store.updateCredentialHealth)?.({ businessId, status: "needs_attention" });
          return attention(businessId, checkedAt);
        }
        const crypto = options.crypto ?? defaultCrypto();
        const decryptCredential = options.decryptCredential ?? crypto.decryptCredential.bind(crypto);
        const payload = await decryptCredential({
          businessId, accountBindingKey: row.account_binding_key, encryptedToken: row.encrypted_credential,
        });
        const accountId = payload?.account_id;
        const accessToken = payload?.access_token;
        const scopes = Array.isArray(payload?.scope)
          ? payload.scope
          : typeof payload?.scope === "string" ? payload.scope.split(/[\s,]+/).filter(Boolean) : [];
        const publishingRequired = client.integrations?.instagram?.review_publish_enabled === true;
        if (typeof accountId !== "string" || !accountId || typeof accessToken !== "string" || !accessToken
          || !scopes.includes("instagram_business_basic")
          || (publishingRequired && !scopes.includes(INSTAGRAM_CONTENT_PUBLISH_SCOPE))
          || !crypto.accountBindingKeys(accountId).includes(row.account_binding_key)) return attention(businessId, checkedAt);
        let identity;
        try {
          identity = await verifyIdentity({ accessToken });
        } catch (error) {
          if (error?.code === "invalid_identity") {
            await (options.updateCredentialHealth ?? store.updateCredentialHealth)?.({ businessId, status: "needs_attention" });
            return attention(businessId, checkedAt);
          }
          return attention(businessId, checkedAt, ACTIONS.retry);
        }
        if (!identity || identity.accountId !== accountId || typeof identity.username !== "string" || !identity.username) {
          await (options.updateCredentialHealth ?? store.updateCredentialHealth)?.({ businessId, status: "needs_attention" });
          return attention(businessId, checkedAt);
        }
        await (options.updateCredentialHealth ?? store.updateCredentialHealth)?.({
          businessId, status: "active", username: identity.username,
          displayName: identity.name ?? identity.username, lastVerifiedAt: checked,
        });
        return json(200, statusBody(businessId, "Connected", checkedAt, {
          account: { username: identity.username, name: identity.name ?? identity.username },
        }));
      }
      safeWarn("credential_not_found");
    } catch {
      // A stored row or an ambiguous storage failure must never activate legacy credentials.
      safeWarn("credential_read_or_decrypt_failed");
      return attention(businessId, checkedAt, ACTIONS.retry);
    }

    const isDevelopment = env("CONTEXT") === "dev";
    const hasLegacyReferences = Boolean(client.integrations?.instagram?.token_env && client.integrations?.instagram?.account_id_env);
    const fallbackAllowed = typeof legacyFallbackEnabled === "function"
      ? legacyFallbackEnabled({ businessId, client, env })
      : legacyFallbackEnabled === true;
    if (!isDevelopment || !hasLegacyReferences || !fallbackAllowed) {
      return json(200, statusBody(businessId, "Not Connected", checkedAt, { action: ACTIONS.connect }));
    }
    const accessToken = env(client.integrations.instagram.token_env);
    const expectedAccountId = env(client.integrations.instagram.account_id_env);
    if (!accessToken) return json(200, statusBody(businessId, "Not Connected", checkedAt, { action: ACTIONS.connect }));
    if (!expectedAccountId) return attention(businessId, checkedAt);
    try {
      const identity = await verifyIdentity({ accessToken });
      if (!identity || identity.accountId !== String(expectedAccountId) || !identity.username) return attention(businessId, checkedAt);
      return json(200, statusBody(businessId, "Connected", checkedAt, {
        account: { username: identity.username, name: identity.name ?? identity.username },
      }));
    } catch { return attention(businessId, checkedAt, ACTIONS.retry); }
  };
}

export default createInstagramConnectionHandler();
