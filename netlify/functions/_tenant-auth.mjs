import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TENANT_KEY_PREFIX = "gw_tenant_";
const TENANT_KEY_PATTERN = /^gw_tenant_[A-Za-z0-9_-]{43}$/;
const TENANT_LOGIN_PREFIX = "gw_login_";
const TENANT_LOGIN_PATTERN = /^gw_login_[A-Za-z0-9_-]{43}$/;
const TENANT_SESSION_PREFIX = "gw_tsession_";
const TENANT_SESSION_PATTERN = /^gw_tsession_[A-Za-z0-9_-]{43}$/;
export const TENANT_SESSION_COOKIE = "__Host-gw_tenant_session";

function slug(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "business";
}

export function hashTenantAccessKey(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function generateTenantLoginToken() {
  return `${TENANT_LOGIN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function generateTenantSessionToken() {
  return `${TENANT_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export function hashTenantLoginToken(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function hashTenantSessionToken(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function validTenantLoginToken(value) {
  return TENANT_LOGIN_PATTERN.test(String(value ?? ""));
}

export function validTenantSessionToken(value) {
  return TENANT_SESSION_PATTERN.test(String(value ?? ""));
}

export function readTenantSessionCookie(request) {
  const header = request?.headers?.get("cookie") || "";
  const matches = header.split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${TENANT_SESSION_COOKIE}=`));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(TENANT_SESSION_COOKIE.length + 1);
  return validTenantSessionToken(value) ? value : null;
}

export function generateTenantCredentials({ businessName } = {}) {
  const tenantKey = `${TENANT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return {
    businessId: `${slug(businessName)}-${randomBytes(6).toString("hex")}`,
    tenantKey,
    accessKeyHash: hashTenantAccessKey(tenantKey),
  };
}

function hashesMatch(left, right) {
  if (!/^[a-f0-9]{64}$/.test(String(left)) || !/^[a-f0-9]{64}$/.test(String(right))) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export async function authorizeTenantRequest(request, { businessId, store, now = new Date() } = {}) {
  const id = typeof businessId === "string" ? businessId.trim() : "";
  if (!id || !store) return { ok: false, via: "none", businessId: null };

  const key = request?.headers?.get("x-growthwise-tenant-key")?.trim() || "";
  if (TENANT_KEY_PATTERN.test(key) && store?.readTenantAuth) {
    let tenant;
    try {
      tenant = await store.readTenantAuth({ businessId: id });
    } catch {
      return { ok: false, via: "none", businessId: null };
    }
    if (tenant && tenant.business_id === id
      && hashesMatch(hashTenantAccessKey(key), tenant.access_key_hash)) {
      return { ok: true, via: "tenant", businessId: id };
    }
  }

  const sessionToken = readTenantSessionCookie(request);
  if (!sessionToken || !store?.authorizeTenantSession) {
    return { ok: false, via: "none", businessId: null };
  }
  try {
    const session = await store.authorizeTenantSession({
      sessionHash: hashTenantSessionToken(sessionToken),
      businessId: id,
      now,
    });
    if (session?.business_id === id) {
      return { ok: true, via: "tenant_session", businessId: id };
    }
  } catch {}
  return { ok: false, via: "none", businessId: null };
}
