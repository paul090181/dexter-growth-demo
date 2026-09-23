import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TENANT_KEY_PREFIX = "gw_tenant_";
const TENANT_KEY_PATTERN = /^gw_tenant_[A-Za-z0-9_-]{43}$/;

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

export async function authorizeTenantRequest(request, { businessId, store } = {}) {
  const id = typeof businessId === "string" ? businessId.trim() : "";
  const key = request?.headers?.get("x-growthwise-tenant-key")?.trim() || "";
  if (!id || !TENANT_KEY_PATTERN.test(key) || !store?.readTenantAuth) {
    return { ok: false, via: "none", businessId: null };
  }

  let tenant;
  try {
    tenant = await store.readTenantAuth({ businessId: id });
  } catch {
    return { ok: false, via: "none", businessId: null };
  }
  if (!tenant || tenant.business_id !== id || !hashesMatch(hashTenantAccessKey(key), tenant.access_key_hash)) {
    return { ok: false, via: "none", businessId: null };
  }
  return { ok: true, via: "tenant", businessId: id };
}
