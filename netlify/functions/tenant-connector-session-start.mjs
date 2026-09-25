import {
  CONNECTOR_SESSION_COOKIE,
  generateOpaqueToken,
  hashOpaqueToken,
} from "./_connector-auth.mjs";
import {
  CONNECTOR_SESSION_TTL_MS,
  createConnectorStore,
} from "./_connector-store.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { hasEntitlement, resolveSubscriptionEntitlements } from "./_entitlements.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const CONNECTORS = Object.freeze(["email", "instagram"]);

function configuredOrigin() {
  return resolveGrowthWisePublicOrigin();
}

export function createTenantConnectorSessionStartHandler(options = {}) {
  const tenantStore = options.tenantStore ?? createTenantStore();
  const billingStore = options.billingStore ?? createBillingStore();
  const connectorStore = options.connectorStore ?? createConnectorStore();
  const authorize = options.authorize ?? authorizeTenantRequest;
  const publicOrigin = options.publicOrigin ?? configuredOrigin;
  const now = options.now ?? (() => new Date());

  return async function tenantConnectorSessionStart(request) {
    if (request.method !== "POST") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    }

    let origin;
    let requestUrl;
    try {
      origin = canonicalOrigin(publicOrigin());
      requestUrl = new URL(request.url);
    } catch {
      return connectorJson(503, { error: "Connection setup is unavailable." });
    }

    const fetchSite = request.headers.get("sec-fetch-site");
    if (requestUrl.origin !== origin
      || requestUrl.pathname !== "/.netlify/functions/tenant-connector-session-start"
      || requestUrl.search
      || requestUrl.hash
      || request.headers.get("origin") !== origin
      || (fetchSite !== null && fetchSite !== "same-origin")) {
      return connectorJson(403, { error: "Request origin was rejected." });
    }

    let body;
    try {
      body = await readConnectorJson(request);
    } catch {
      return connectorJson(400, { error: "Invalid request." });
    }

    if (!exactKeys(body, ["business_id"])
      || typeof body.business_id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)
      || body.business_id.length > 80) {
      return connectorJson(400, { error: "Invalid request." });
    }

    const auth = await authorize(request, {
      businessId: body.business_id,
      store: tenantStore,
    });
    if (!auth?.ok || auth.businessId !== body.business_id) {
      return connectorJson(401, { error: "Tenant credentials are invalid." });
    }

    let subscription;
    try {
      subscription = await billingStore.readSubscription({ businessId: body.business_id });
    } catch {
      return connectorJson(503, { error: "Business account is temporarily unavailable." });
    }

    const entitlements = resolveSubscriptionEntitlements(subscription, { now: now() });
    if (!hasEntitlement(entitlements, "unified_inbox")) {
      return connectorJson(403, { error: "Connected channels are not included in this plan." });
    }

    const sessionToken = generateOpaqueToken("session");
    const startedAt = now();
    const expiresAt = new Date(startedAt.getTime() + CONNECTOR_SESSION_TTL_MS);

    try {
      await connectorStore.createSession({
        sessionHash: hashOpaqueToken(sessionToken),
        businessId: body.business_id,
        connectors: [...CONNECTORS],
        expiresAt,
      });
    } catch {
      return connectorJson(503, { error: "Connection setup is temporarily unavailable." });
    }

    return connectorJson(200, {
      ok: true,
      connection_url: "/connect-accounts.html",
      expires_at: expiresAt.toISOString(),
    }, {
      "set-cookie": `${CONNECTOR_SESSION_COOKIE}=${sessionToken}; Max-Age=1800; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  };
}

export default function handler(request) {
  return createTenantConnectorSessionStartHandler()(request);
}
