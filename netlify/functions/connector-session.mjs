import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { connectorJson } from "./_connector-http.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { createConnectorTenantResolver } from "./_connector-tenants.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

function configuredFacebookAvailable() {
  const appId = globalThis.Netlify?.env?.get("GROWTHWISE_FACEBOOK_APP_ID")
    || globalThis.Netlify?.env?.get("GROWTHWISE_INSTAGRAM_APP_ID");
  const appSecret = globalThis.Netlify?.env?.get("GROWTHWISE_FACEBOOK_APP_SECRET")
    || globalThis.Netlify?.env?.get("GROWTHWISE_INSTAGRAM_APP_SECRET");
  const required = [
    appId,
    appSecret,
    globalThis.Netlify?.env?.get("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    globalThis.Netlify?.env?.get("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    globalThis.Netlify?.env?.get("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  ];
  return required.every((value) => typeof value === "string" && value.trim().length > 0);
}

function configuredMicrosoftMailAvailable() {
  const required = [
    "GROWTHWISE_MICROSOFT_CLIENT_ID",
    "GROWTHWISE_MICROSOFT_CLIENT_SECRET",
    "GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET",
    "GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET",
    "GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY",
  ];
  return required.every((name) => {
    const value = globalThis.Netlify?.env?.get(name);
    return typeof value === "string" && value.trim().length > 0;
  });
}

export function createConnectorSessionHandler({
  store,
  now = () => new Date(),
  resolveTenant,
  microsoftMailAvailable = configuredMicrosoftMailAvailable,
  facebookAvailable = configuredFacebookAvailable,
} = {}) {
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
          ? (() => {
              const available = facebookAvailable() === true;
              return {
                allowed: true,
                available,
                state: available ? "Not Connected" : "Setup unavailable",
              };
            })()
          : { allowed: false, available: false, state: "Setup unavailable" },
        instagram: { allowed: auth.connectors.includes("instagram"), available: auth.connectors.includes("instagram") },
        email: auth.connectors.includes("email")
          ? (() => {
              const available = microsoftMailAvailable() === true;
              return {
                allowed: true,
                available,
                state: available ? "Not Connected" : "Setup unavailable",
              };
            })()
          : { allowed: false, available: false, state: "Setup unavailable" },
        website: auth.connectors.includes("website")
          ? { allowed: true, available: true, state: "Not Connected" }
          : { allowed: false, available: false, state: "Setup unavailable" },
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
