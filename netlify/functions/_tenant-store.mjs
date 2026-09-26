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
  SELECT business_id, business_name, contact_name, contact_email, created_at, updated_at
    FROM growthwise_tenants
   WHERE business_id = $1`;

const READ_TENANTS_BY_EMAIL = `
  SELECT business_id, business_name, contact_name, contact_email
    FROM growthwise_tenants
   WHERE contact_email = $1
   ORDER BY created_at ASC, business_id ASC`;

const INSERT_LOGIN_TOKEN = `
  INSERT INTO growthwise_tenant_login_tokens
    (token_hash, business_id, request_bucket, expires_at)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (business_id, request_bucket) DO NOTHING
  RETURNING token_hash, business_id, expires_at, created_at`;

const LOCK_LOGIN_TOKEN = `
  SELECT token_hash, business_id, expires_at, consumed_at
    FROM growthwise_tenant_login_tokens
   WHERE token_hash = $1
   FOR UPDATE`;

const INSERT_TENANT_SESSION = `
  INSERT INTO growthwise_tenant_sessions
    (session_hash, business_id, expires_at)
  VALUES ($1, $2, $3)
  RETURNING session_hash, business_id, expires_at, created_at`;

const MARK_LOGIN_TOKEN_CONSUMED = `
  UPDATE growthwise_tenant_login_tokens
     SET consumed_at = $2
   WHERE token_hash = $1 AND consumed_at IS NULL
  RETURNING token_hash`;

const READ_TENANT_SESSION = `
  SELECT session_hash, business_id, expires_at, revoked_at
    FROM growthwise_tenant_sessions
   WHERE session_hash = $1`;

const REVOKE_TENANT_SESSION = `
  UPDATE growthwise_tenant_sessions
     SET revoked_at = $2
   WHERE session_hash = $1 AND revoked_at IS NULL
  RETURNING session_hash`;

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

  async function listTenantsByEmail({ email } = {}) {
    const value = requiredString(email, "INVALID_CONTACT_EMAIL", 254).toLowerCase();
    try {
      const result = await (await getPool()).query(READ_TENANTS_BY_EMAIL, [value]);
      return result.rows;
    } catch (error) {
      if (error?.message === "INVALID_CONTACT_EMAIL") throw error;
      throw safeError("TENANT_EMAIL_READ_FAILED", error);
    }
  }

  async function createLoginToken({ tokenHash, businessId, requestBucket, expiresAt } = {}) {
    const hash = requiredString(tokenHash, "INVALID_LOGIN_TOKEN_HASH", 64);
    const id = requiredString(businessId, "INVALID_BUSINESS_ID", 80);
    const bucket = requestBucket instanceof Date ? requestBucket : new Date(requestBucket);
    const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw safeError("INVALID_LOGIN_TOKEN_HASH");
    if (!Number.isFinite(bucket.getTime()) || !Number.isFinite(expiry.getTime())) {
      throw safeError("INVALID_LOGIN_TOKEN_TIME");
    }
    try {
      const result = await (await getPool()).query(INSERT_LOGIN_TOKEN, [hash, id, bucket, expiry]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw safeError("LOGIN_TOKEN_CREATE_FAILED", error);
    }
  }

  async function redeemLoginToken({ tokenHash, sessionHash, now, sessionExpiresAt } = {}) {
    const loginHash = requiredString(tokenHash, "INVALID_LOGIN_TOKEN_HASH", 64);
    const authHash = requiredString(sessionHash, "INVALID_SESSION_HASH", 64);
    const checkedAt = now instanceof Date ? now : new Date(now);
    const sessionExpiry = sessionExpiresAt instanceof Date ? sessionExpiresAt : new Date(sessionExpiresAt);
    if (!/^[a-f0-9]{64}$/.test(loginHash)) throw safeError("INVALID_LOGIN_TOKEN_HASH");
    if (!/^[a-f0-9]{64}$/.test(authHash)) throw safeError("INVALID_SESSION_HASH");
    if (!Number.isFinite(checkedAt.getTime()) || !Number.isFinite(sessionExpiry.getTime())) {
      throw safeError("INVALID_SESSION_TIME");
    }

    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const token = (await client.query(LOCK_LOGIN_TOKEN, [loginHash])).rows[0];
      const expiresAt = token?.expires_at ? new Date(token.expires_at) : null;
      if (!token || token.consumed_at || !expiresAt
        || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= checkedAt.getTime()) {
        throw safeError("LOGIN_TOKEN_INVALID");
      }
      await client.query(INSERT_TENANT_SESSION, [authHash, token.business_id, sessionExpiry]);
      const marked = await client.query(MARK_LOGIN_TOKEN_CONSUMED, [loginHash, checkedAt]);
      if (!marked.rows[0]) throw safeError("LOGIN_TOKEN_INVALID");
      await client.query("COMMIT");
      return {
        business_id: token.business_id,
        expires_at: sessionExpiry,
      };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (String(error?.message || "").startsWith("INVALID_") || error?.message === "LOGIN_TOKEN_INVALID") throw error;
      throw safeError("LOGIN_TOKEN_REDEEM_FAILED", error);
    } finally {
      client.release();
    }
  }

  async function authorizeTenantSession({ sessionHash, businessId, now } = {}) {
    const hash = requiredString(sessionHash, "INVALID_SESSION_HASH", 64);
    const id = requiredString(businessId, "INVALID_BUSINESS_ID", 80);
    const checkedAt = now instanceof Date ? now : new Date(now);
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(checkedAt.getTime())) {
      throw safeError("SESSION_INVALID");
    }
    try {
      const row = (await (await getPool()).query(READ_TENANT_SESSION, [hash])).rows[0];
      const expiresAt = row?.expires_at ? new Date(row.expires_at) : null;
      if (!row || row.business_id !== id || row.revoked_at || !expiresAt
        || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= checkedAt.getTime()) {
        throw safeError("SESSION_INVALID");
      }
      return { business_id: row.business_id, expires_at: expiresAt };
    } catch (error) {
      if (error?.message === "SESSION_INVALID") throw error;
      throw safeError("SESSION_READ_FAILED", error);
    }
  }

  async function revokeTenantSession({ sessionHash, now } = {}) {
    const hash = requiredString(sessionHash, "INVALID_SESSION_HASH", 64);
    const revokedAt = now instanceof Date ? now : new Date(now);
    if (!/^[a-f0-9]{64}$/.test(hash) || !Number.isFinite(revokedAt.getTime())) {
      throw safeError("SESSION_INVALID");
    }
    try {
      const result = await (await getPool()).query(REVOKE_TENANT_SESSION, [hash, revokedAt]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (error?.message === "SESSION_INVALID") throw error;
      throw safeError("SESSION_REVOKE_FAILED", error);
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

  return {
    createTenant,
    readTenantAuth,
    readTenantProfile,
    listTenantsByEmail,
    createLoginToken,
    redeemLoginToken,
    authorizeTenantSession,
    revokeTenantSession,
  };
}
