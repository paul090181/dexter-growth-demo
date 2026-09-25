const INSERT_TENANT = `
  INSERT INTO growthwise_tenants
    (business_id, business_name, contact_name, contact_email, access_key_hash)
  VALUES ($1, $2, $3, $4, $5)
  RETURNING business_id, business_name, contact_name, contact_email, access_key_hash,
            created_at, updated_at`;

const READ_TENANT_AUTH = `
  SELECT business_id, access_key_hash
    FROM growthwise_tenants
   WHERE business_id = $1`;

const READ_TENANT_PROFILE = `
  SELECT business_id, business_name
    FROM growthwise_tenants
   WHERE business_id = $1`;

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function safeError(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function requiredString(value, code, max) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!clean || clean.length > max) throw safeError(code);
  return clean;
}

export function createTenantStore({ getPool = netlifyPool } = {}) {
  async function createTenant(input = {}) {
    const values = [
      requiredString(input.businessId, "INVALID_BUSINESS_ID", 80),
      requiredString(input.businessName, "INVALID_BUSINESS_NAME", 160),
      requiredString(input.contactName, "INVALID_CONTACT_NAME", 160),
      requiredString(input.email, "INVALID_CONTACT_EMAIL", 254).toLowerCase(),
      requiredString(input.accessKeyHash, "INVALID_ACCESS_KEY_HASH", 64),
    ];
    if (!/^[a-f0-9]{64}$/.test(values[4])) throw safeError("INVALID_ACCESS_KEY_HASH");
    try {
      const result = await (await getPool()).query(INSERT_TENANT, values);
      return result.rows[0];
    } catch (error) {
      if (error?.code === "23505") throw safeError("TENANT_CONFLICT", error);
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw safeError("TENANT_CREATE_FAILED", error);
    }
  }

  async function readTenantAuth({ businessId } = {}) {
    const id = requiredString(businessId, "INVALID_BUSINESS_ID", 80);
    try {
      const result = await (await getPool()).query(READ_TENANT_AUTH, [id]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (error?.message === "INVALID_BUSINESS_ID") throw error;
      throw safeError("TENANT_READ_FAILED", error);
    }
  }

  async function readTenantProfile({ businessId } = {}) {
    const id = requiredString(businessId, "INVALID_BUSINESS_ID", 80);
    try {
      const result = await (await getPool()).query(READ_TENANT_PROFILE, [id]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (error?.message === "INVALID_BUSINESS_ID") throw error;
      throw safeError("TENANT_READ_FAILED", error);
    }
  }

  return { createTenant, readTenantAuth, readTenantProfile };
}
