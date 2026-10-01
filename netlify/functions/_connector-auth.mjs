import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const PREFIXES = Object.freeze({ invitation: "gw_inv_", session: "gw_conn_" });
export const invitationTokenPattern = /^gw_inv_[A-Za-z0-9_-]{43}$/;
export const sessionTokenPattern = /^gw_conn_[A-Za-z0-9_-]{43}$/;

export function generateOpaqueToken(kind) {
  const prefix = PREFIXES[kind];
  if (!prefix) throw new Error("INVALID_TOKEN_KIND");
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function hashOpaqueToken(token) {
  return createHash("sha256").update(String(token ?? ""), "utf8").digest("hex");
}

export function validOpaqueToken(token, kind) {
  return kind === "invitation" ? invitationTokenPattern.test(String(token ?? ""))
    : kind === "session" ? sessionTokenPattern.test(String(token ?? "")) : false;
}

export function safeHashEqual(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export const CONNECTOR_SESSION_COOKIE = "__Host-gw_connector_session";

export function readConnectorSessionCookie(request) {
  const header = request?.headers?.get("cookie") || "";
  const matches = header.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${CONNECTOR_SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(CONNECTOR_SESSION_COOKIE.length + 1);
  return validOpaqueToken(value, "session") ? value : null;
}

export async function authorizeConnectorRequest(request, { store, businessId, connector, now = new Date() } = {}) {
  const token = readConnectorSessionCookie(request);
  if (!token || !store?.authorizeSession) return { ok: false, businessId: null, connectors: [] };
  try {
    const row = await store.authorizeSession({
      sessionHash: hashOpaqueToken(token), businessId, connector, now,
    });
    return { ok: true, businessId: row.business_id, connectors: [...row.connectors], expiresAt: row.expires_at };
  } catch {
    return { ok: false, businessId: null, connectors: [] };
  }
}
