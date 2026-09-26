import {
  TENANT_SESSION_COOKIE,
  generateTenantSessionToken,
  hashTenantLoginToken,
  hashTenantSessionToken,
  validTenantLoginToken,
} from "./_tenant-auth.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function configuredOrigin(requestUrl = "") {
  return resolveGrowthWisePublicOrigin(undefined, requestUrl);
}

const CLEAR_COOKIE = `${TENANT_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

export function createTenantLoginExchangeHandler(options = {}) {
  const store = options.store ?? createTenantStore();
  const publicOrigin = options.publicOrigin ?? configuredOrigin;
  const now = options.now ?? (() => new Date());

  return async function tenantLoginExchange(request) {
    if (request.method !== "POST") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    }

    let origin;
    let requestUrl;
    try {
      origin = canonicalOrigin(publicOrigin(request.url));
      requestUrl = new URL(request.url);
    } catch {
      return connectorJson(503, { error: "Email sign-in is unavailable." }, {
        "set-cookie": CLEAR_COOKIE,
      });
    }

    const fetchSite = request.headers.get("sec-fetch-site");
    if (requestUrl.origin !== origin
      || requestUrl.pathname !== "/.netlify/functions/tenant-login-exchange"
      || requestUrl.search
      || requestUrl.hash
      || request.headers.get("origin") !== origin
      || (fetchSite !== null && fetchSite !== "same-origin")) {
      return connectorJson(403, { error: "Request origin was rejected." }, {
        "set-cookie": CLEAR_COOKIE,
      });
    }

    let body;
    try { body = await readConnectorJson(request); }
    catch {
      return connectorJson(401, { error: "This sign-in link is invalid or expired." }, {
        "set-cookie": CLEAR_COOKIE,
      });
    }

    const token = exactKeys(body, ["token"]) && validTenantLoginToken(body.token)
      ? body.token
      : "";
    if (!token) {
      return connectorJson(401, { error: "This sign-in link is invalid or expired." }, {
        "set-cookie": CLEAR_COOKIE,
      });
    }

    const sessionToken = generateTenantSessionToken();
    const checkedAt = now();
    const expiresAt = new Date(checkedAt.getTime() + SESSION_TTL_MS);

    let session;
    try {
      session = await store.redeemLoginToken({
        tokenHash: hashTenantLoginToken(token),
        sessionHash: hashTenantSessionToken(sessionToken),
        now: checkedAt,
        sessionExpiresAt: expiresAt,
      });
    } catch {
      return connectorJson(401, { error: "This sign-in link is invalid or expired." }, {
        "set-cookie": CLEAR_COOKIE,
      });
    }

    return connectorJson(200, {
      ok: true,
      business_id: session.business_id,
      expires_at: expiresAt.toISOString(),
    }, {
      "set-cookie": `${TENANT_SESSION_COOKIE}=${sessionToken}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  };
}

export default function handler(request) {
  return createTenantLoginExchangeHandler()(request);
}
