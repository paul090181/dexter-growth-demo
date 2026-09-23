import { generateOpaqueToken, hashOpaqueToken } from "./_connector-auth.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { createConnectorTenantResolver } from "./_connector-tenants.mjs";
import { authorized as defaultAuthorized } from "./_lead-store.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;
const ALLOWED = new Set(["email", "facebook", "instagram"]);

function configuredOrigin() { return globalThis.Netlify?.env?.get("GROWTHWISE_PUBLIC_ORIGIN"); }

export function createConnectorInvitationCreateHandler(options = {}) {
  const authorized = options.authorized ?? defaultAuthorized;
  const store = options.store;
  const resolveTenant = options.resolveTenant;
  const publicOrigin = options.publicOrigin ?? configuredOrigin;
  const now = options.now ?? (() => new Date());
  return async function connectorInvitationCreate(request) {
    if (request.method !== "POST") return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    if (!authorized(request).ok) return connectorJson(401, { error: "Unauthorized." });
    let body;
    try { body = await readConnectorJson(request); } catch { return connectorJson(400, { error: "Invalid request." }); }
    if (!exactKeys(body, ["business_id", "connectors"])) return connectorJson(400, { error: "Invalid request." });
    const businessId = typeof body.business_id === "string" ? body.business_id.trim() : "";
    const connectors = Array.isArray(body.connectors) ? [...new Set(body.connectors)].sort() : [];
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId) || connectors.length === 0
      || connectors.some((connector) => !ALLOWED.has(connector))) return connectorJson(400, { error: "Invalid request." });
    const tenant = await resolveTenant(businessId);
    if (!tenant || tenant.business_id !== businessId) return connectorJson(400, { error: "Invalid request." });
    let origin;
    try { origin = canonicalOrigin(publicOrigin()); } catch { return connectorJson(503, { error: "Invitation service unavailable." }); }
    const invitationToken = generateOpaqueToken("invitation");
    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + INVITATION_TTL_MS);
    try {
      await store.createInvitation({
        invitationHash: hashOpaqueToken(invitationToken), businessId, connectors, expiresAt,
      });
    } catch { return connectorJson(503, { error: "Invitation could not be created." }); }
    const invitationUrl = new URL("/connect-accounts.html", origin);
    invitationUrl.hash = `invite=${invitationToken}`;
    return connectorJson(201, {
      business_id: businessId, connectors, expires_at: expiresAt.toISOString(), invitation_url: invitationUrl.toString(),
    });
  };
}

export default function handler(request) {
  const tenantStore = createTenantStore();
  return createConnectorInvitationCreateHandler({
    store: createConnectorStore(),
    resolveTenant: createConnectorTenantResolver({ tenantStore }),
  })(request);
}
