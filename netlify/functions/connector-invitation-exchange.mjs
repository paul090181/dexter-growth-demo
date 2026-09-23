import {
  CONNECTOR_SESSION_COOKIE, generateOpaqueToken, hashOpaqueToken, validOpaqueToken,
} from "./_connector-auth.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { createConnectorStore } from "./_connector-store.mjs";

function configuredOrigin() { return globalThis.Netlify?.env?.get("GROWTHWISE_PUBLIC_ORIGIN"); }

export function createConnectorInvitationExchangeHandler(options = {}) {
  const store = options.store;
  const publicOrigin = options.publicOrigin ?? configuredOrigin;
  const now = options.now ?? (() => new Date());
  return async function connectorInvitationExchange(request) {
    if (request.method !== "POST") return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    let origin;
    try { origin = canonicalOrigin(publicOrigin()); } catch { return connectorJson(503, { error: "Invitation service unavailable." }); }
    let requestUrl;
    try { requestUrl = new URL(request.url); } catch { return connectorJson(403, { error: "Request rejected." }); }
    if (requestUrl.origin !== origin || request.headers.get("origin") !== origin || requestUrl.search || requestUrl.hash) {
      return connectorJson(403, { error: "Request rejected." });
    }
    let body;
    try { body = await readConnectorJson(request); } catch { return connectorJson(401, { error: "Invitation is invalid or expired." }); }
    if (!exactKeys(body, ["invitation_token"]) || !validOpaqueToken(body.invitation_token, "invitation")) {
      return connectorJson(401, { error: "Invitation is invalid or expired." });
    }
    const sessionToken = generateOpaqueToken("session");
    let session;
    try {
      session = await store.redeemInvitation({
        invitationHash: hashOpaqueToken(body.invitation_token), sessionHash: hashOpaqueToken(sessionToken), now: now(),
      });
    } catch { return connectorJson(401, { error: "Invitation is invalid or expired." }); }
    return connectorJson(200, {
      business_id: session.business_id, expires_at: new Date(session.expires_at).toISOString(),
    }, {
      "set-cookie": `${CONNECTOR_SESSION_COOKIE}=${sessionToken}; Max-Age=1800; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  };
}

export default function handler(request) {
  return createConnectorInvitationExchangeHandler({ store: createConnectorStore() })(request);
}
