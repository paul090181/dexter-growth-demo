import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import { authorizeTenantFacebookPublishingRequest } from "./_tenant-facebook-auth.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function env(name) {
  return globalThis.Netlify?.env?.get(name) ?? "";
}

function versions(name) {
  return { current: { id: "v1", key: env(name) } };
}

function createCrypto() {
  return createFacebookCrypto({
    stateSecrets: versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function requestBusinessId(request) {
  try {
    const url = new URL(request.url);
    if (url.pathname !== "/.netlify/functions/tenant-facebook-connection"
      || url.hash
      || url.searchParams.size !== 1
      || url.searchParams.getAll("business_id").length !== 1) return "";
    const value = url.searchParams.get("business_id") || "";
    return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80 ? value : "";
  } catch {
    return "";
  }
}

export function createTenantFacebookConnectionHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantFacebookPublishingRequest;
  const now = options.now ?? (() => new Date());

  return async function tenantFacebookConnection(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });
    const businessId = requestBusinessId(request);
    if (!businessId) return json(400, { error: "Invalid request." });

    const auth = await authorize(request, { businessId, now: now() });
    if (!auth?.ok) {
      const status = auth?.via === "locked" ? 403 : auth?.via === "unavailable" ? 503 : 401;
      return json(status, {
        error: status === 403
          ? "Facebook publishing is not included in this plan."
          : status === 503
            ? "Business account is temporarily unavailable."
            : "Tenant credentials are invalid.",
      });
    }

    let store;
    try {
      store = options.store ?? createFacebookStore({ crypto: options.crypto ?? createCrypto() });
    } catch {
      return json(503, { error: "Facebook connection is temporarily unavailable." });
    }

    let row;
    try {
      row = await store.readCredential({ businessId });
    } catch {
      return json(503, { error: "Facebook connection is temporarily unavailable." });
    }

    if (!row) {
      return json(200, {
        business_id: businessId,
        state: "Not Connected",
        account: null,
        action: "Connect this business's Facebook Page in Customer channels.",
      });
    }

    if (row.status !== "active") {
      return json(200, {
        business_id: businessId,
        state: "Needs Attention",
        account: row.page_name ? { page_name: row.page_name } : null,
        action: "Reconnect this business's Facebook Page before publishing.",
      });
    }

    return json(200, {
      business_id: businessId,
      state: "Connected",
      account: { page_name: row.page_name || "Connected Facebook Page" },
      action: "",
      last_verified_at: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
    });
  };
}

export default createTenantFacebookConnectionHandler();
