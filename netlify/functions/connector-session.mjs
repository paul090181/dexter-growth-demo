import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { connectorJson } from "./_connector-http.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { createConnectorTenantResolver } from "./_connector-tenants.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

export function createConnectorSessionHandler({ store, now = () => new Date(), resolveTenant } = {}) {
  return async function connectorSession(request) {
    if (request.method !== "GET") return connectorJson(405, { error: "Method not allowed." }, { allow: "GET" });
    const url = new URL(request.url);
    if (url.search || url.hash) return connectorJson(400, { error: "Invalid request." });
    const auth = await authorizeConnectorRequest(request, { store, now: now() });
    if (!auth.ok) return connectorJson(401, { error: "Session is invalid or expired." });
    const tenant = await resolveTenant(auth.businessId);
    if (!tenant || tenant.business_id !== auth.businessId) return connectorJson(401, { error: "Session is invalid or expired." });
    return connectorJson(200, {
      business_id: auth.businessId,
      business_name: tenant.business_name,
      expires_at: new Date(auth.expiresAt).toISOString(),
      connectors: {
        facebook: auth.connectors.includes("facebook")
          ? { allowed: true, available: false, state: "Setup unavailable" }
          : { allowed: false, available: false, state: "Setup unavailable" },
        instagram: { allowed: auth.connectors.includes("instagram"), available: auth.connectors.includes("instagram") },
      },
    });
  };
}

export default function handler(request) {
  const tenantStore = createTenantStore();
  return createConnectorSessionHandler({
    store: createConnectorStore(),
    resolveTenant: createConnectorTenantResolver({ tenantStore }),
  })(request);
}
