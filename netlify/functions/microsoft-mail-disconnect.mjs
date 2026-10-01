import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import {
  canonicalOrigin,
  connectorJson,
  exactKeys,
  readConnectorJson,
} from "./_connector-http.mjs";
import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";
import { getMicrosoftMailAccess } from "./_microsoft-mail-access.mjs";
import { deleteMicrosoftMailSubscription } from "./_microsoft-mail-graph.mjs";

const PATH = "/.netlify/functions/microsoft-mail-disconnect";

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

export function createMicrosoftMailDisconnectHandler(options = {}) {
  const connectorStore = options.connectorStore ?? createConnectorStore();
  const connectorAuthorize = options.connectorAuthorize ?? authorizeConnectorRequest;
  const publicOrigin = options.publicOrigin ?? (() => env("GROWTHWISE_PUBLIC_ORIGIN"));
  const now = options.now ?? (() => new Date());
  const access = options.access ?? getMicrosoftMailAccess;
  const deleteRemoteSubscription = options.deleteRemoteSubscription ?? deleteMicrosoftMailSubscription;

  return async function microsoftMailDisconnect(request) {
    if (request.method !== "POST") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    }

    let origin;
    let url;
    try {
      origin = canonicalOrigin(publicOrigin());
      url = new URL(request.url);
    } catch {
      return connectorJson(503, {
        error: "Microsoft email connection is not configured.",
      });
    }

    if (url.origin !== origin
      || url.pathname !== PATH
      || url.search
      || url.hash
      || request.headers.get("origin") !== origin
      || (request.headers.get("sec-fetch-site") !== null
        && request.headers.get("sec-fetch-site") !== "same-origin")) {
      return connectorJson(403, { error: "Request origin was rejected." });
    }

    let body;
    try { body = await readConnectorJson(request); }
    catch { return connectorJson(400, { error: "Invalid request." }); }

    if (!exactKeys(body, ["business_id"])
      || typeof body.business_id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)) {
      return connectorJson(400, { error: "Invalid request." });
    }

    const auth = await connectorAuthorize(request, {
      store: connectorStore,
      businessId: body.business_id,
      connector: "email",
      now: now(),
    });
    if (!auth?.ok || auth.businessId !== body.business_id) {
      return connectorJson(401, { error: "Session is invalid or expired." });
    }

    const crypto = options.crypto ?? defaultCrypto();
    const store = options.store ?? createMicrosoftMailStore({ crypto });

    let subscription = null;
    try {
      subscription = await store.readSubscriptionByBusiness({ businessId: body.business_id });
    } catch {}

    if (subscription?.subscription_id) {
      try {
        const auth = await access({
          businessId: body.business_id,
          now: now(),
          crypto,
          store,
        });
        await deleteRemoteSubscription({
          accessToken: auth.accessToken,
          subscriptionId: subscription.subscription_id,
        });
      } catch {
        // Local disconnect still proceeds. Without the local subscription secret,
        // any later Graph notification is ignored until the remote subscription expires.
      }
    }

    try {
      await store.deleteSubscriptionByBusiness({ businessId: body.business_id });
      await store.disconnectCredential({ businessId: body.business_id });
      return connectorJson(200, { ok: true });
    } catch {
      return connectorJson(503, {
        error: "Microsoft email could not be disconnected.",
      });
    }
  };
}

export default createMicrosoftMailDisconnectHandler();
