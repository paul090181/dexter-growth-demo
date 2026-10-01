import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { connectorJson } from "./_connector-http.mjs";
import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";

const PATH = "/.netlify/functions/microsoft-mail-connection";
const STORED_STATES = new Set(["active", "needs_attention"]);

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export function createMicrosoftMailConnectionHandler(options = {}) {
  const connectorStore = options.connectorStore ?? createConnectorStore();
  const connectorAuthorize = options.connectorAuthorize ?? authorizeConnectorRequest;
  const now = options.now ?? (() => new Date());

  return async function microsoftMailConnection(request) {
    if (request.method !== "GET") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "GET" });
    }

    const url = new URL(request.url);
    if (url.pathname !== PATH
      || url.hash
      || [...url.searchParams].length !== 1
      || url.searchParams.getAll("business_id").length !== 1) {
      return connectorJson(400, { error: "Invalid request." });
    }

    const businessId = url.searchParams.get("business_id");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId || "")) {
      return connectorJson(400, { error: "Invalid request." });
    }

    const checkedAt = now();
    const auth = await connectorAuthorize(request, {
      store: connectorStore,
      businessId,
      connector: "email",
      now: checkedAt,
    });
    if (!auth?.ok || auth.businessId !== businessId) {
      return connectorJson(401, { error: "Session is invalid or expired." });
    }

    try {
      const store = options.store ?? createMicrosoftMailStore({
        crypto: options.crypto ?? defaultCrypto(),
      });
      const row = await store.readCredential({ businessId });

      if (!row) {
        return connectorJson(200, {
          business_id: businessId,
          state: "Not Connected",
          checked_at: checkedAt.toISOString(),
          action: "Connect a Microsoft business mailbox to receive email leads.",
        });
      }

      const subscription = await store.readSubscriptionByBusiness({ businessId });
      const subscriptionActive = subscription?.status === "active"
        && Number.isFinite(new Date(subscription.expires_at).getTime())
        && new Date(subscription.expires_at).getTime() > checkedAt.getTime();

      if (!STORED_STATES.has(row.status) || row.status !== "active" || !subscriptionActive) {
        return connectorJson(200, {
          business_id: businessId,
          state: "Needs Attention",
          checked_at: checkedAt.toISOString(),
          account: {
            address: row.email_address,
            display_name: row.display_name || row.email_address,
          },
          action: "Reconnect Microsoft email so GrowthWise can restore automatic inbox delivery.",
        });
      }

      return connectorJson(200, {
        business_id: businessId,
        state: "Connected",
        checked_at: checkedAt.toISOString(),
        account: {
          address: row.email_address,
          display_name: row.display_name || row.email_address,
        },
        action: "",
      });
    } catch {
      return connectorJson(503, {
        error: "Microsoft email connection could not be checked.",
      });
    }
  };
}

export default createMicrosoftMailConnectionHandler();
