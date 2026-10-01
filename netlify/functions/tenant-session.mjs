import {
  TENANT_SESSION_COOKIE,
  hashTenantSessionToken,
  readTenantSessionCookie,
} from "./_tenant-auth.mjs";
import { connectorJson } from "./_connector-http.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const CLEAR_COOKIE = `${TENANT_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

export function createTenantSessionHandler({
  store = createTenantStore(),
  now = () => new Date(),
} = {}) {
  return async function tenantSession(request) {
    if (request.method !== "GET") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "GET" });
    }
    const url = new URL(request.url);
    if (url.search || url.hash) return connectorJson(400, { error: "Invalid request." });

    const token = readTenantSessionCookie(request);
    if (!token) return connectorJson(401, { error: "No active session." }, {
      "set-cookie": CLEAR_COOKIE,
    });

    try {
      const session = await store.authorizeTenantSession({
        sessionHash: hashTenantSessionToken(token),
        now: now(),
      });
      return connectorJson(200, {
        ok: true,
        business_id: session.business_id,
        expires_at: new Date(session.expires_at).toISOString(),
      });
    } catch {
      return connectorJson(401, { error: "Session is invalid or expired." }, {
        "set-cookie": CLEAR_COOKIE,
      });
    }
  };
}

export default function handler(request) {
  return createTenantSessionHandler()(request);
}
