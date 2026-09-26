import {
  TENANT_SESSION_COOKIE,
  hashTenantSessionToken,
  readTenantSessionCookie,
} from "./_tenant-auth.mjs";
import { canonicalOrigin, connectorJson } from "./_connector-http.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

function configuredOrigin() {
  return resolveGrowthWisePublicOrigin();
}

const CLEAR_COOKIE = `${TENANT_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

export function createTenantSessionLogoutHandler(options = {}) {
  const store = options.store ?? createTenantStore();
  const publicOrigin = options.publicOrigin ?? configuredOrigin;
  const now = options.now ?? (() => new Date());

  return async function tenantSessionLogout(request) {
    if (request.method !== "POST") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    }
    let origin;
    let url;
    try {
      origin = canonicalOrigin(publicOrigin());
      url = new URL(request.url);
    } catch {
      return connectorJson(200, { ok: true }, { "set-cookie": CLEAR_COOKIE });
    }
    if (url.origin !== origin || url.search || url.hash || request.headers.get("origin") !== origin) {
      return connectorJson(403, { error: "Request origin was rejected." });
    }

    const token = readTenantSessionCookie(request);
    if (token) {
      try {
        await store.revokeTenantSession({
          sessionHash: hashTenantSessionToken(token),
          now: now(),
        });
      } catch {}
    }
    return connectorJson(200, { ok: true }, { "set-cookie": CLEAR_COOKIE });
  };
}

export default function handler(request) {
  return createTenantSessionLogoutHandler()(request);
}
