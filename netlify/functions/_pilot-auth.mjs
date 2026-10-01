import { createHash, randomBytes } from "node:crypto";

const INVITE_PREFIX = "gw_pilot_inv_";
const SESSION_PREFIX = "gw_pilot_";
export const PILOT_SESSION_COOKIE = "__Host-gw_pilot_session";

export const pilotInvitationTokenPattern = /^gw_pilot_inv_[A-Za-z0-9_-]{43}$/;
export const pilotSessionTokenPattern = /^gw_pilot_[A-Za-z0-9_-]{43}$/;

export function generatePilotInvitationToken() {
  return `${INVITE_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generatePilotSessionToken() {
  return `${SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashPilotToken(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function readPilotSessionCookie(request) {
  const header = request?.headers?.get("cookie") || "";
  const matches = header.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${PILOT_SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(PILOT_SESSION_COOKIE.length + 1);
  return pilotSessionTokenPattern.test(value) ? value : null;
}

export async function authorizePilotRequest(request, { store, businessId, now = new Date() } = {}) {
  const token = readPilotSessionCookie(request);
  if (!token || !store?.authorizeSession) return { ok: false, businessId: null };
  try {
    const row = await store.authorizeSession({
      sessionHash: hashPilotToken(token),
      businessId,
      now,
    });
    return {
      ok: true,
      businessId: row.business_id,
      expiresAt: row.expires_at,
    };
  } catch {
    return { ok: false, businessId: null };
  }
}
