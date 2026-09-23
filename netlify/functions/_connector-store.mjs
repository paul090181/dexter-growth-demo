const ALLOWED_CONNECTORS = new Set(["facebook", "instagram"]);
const SESSION_TTL_MS = 30 * 60 * 1000;

const INSERT_INVITATION = `
  INSERT INTO growthwise_connector_invitations
    (invitation_hash, business_id, connectors, expires_at)
  VALUES ($1, $2, $3, $4)
  RETURNING invitation_hash, business_id, connectors, expires_at, revoked_at, used_at`;

const LOCK_INVITATION = `
  SELECT invitation_hash, business_id, connectors, expires_at, revoked_at, used_at
    FROM growthwise_connector_invitations
   WHERE invitation_hash = $1
   FOR UPDATE`;

const INSERT_SESSION = `
  INSERT INTO growthwise_connector_sessions
    (session_hash, business_id, connectors, expires_at)
  VALUES ($1, $2, $3, $4)
  RETURNING session_hash`;

const MARK_USED = `
  UPDATE growthwise_connector_invitations
     SET used_at = $2
   WHERE invitation_hash = $1 AND used_at IS NULL AND revoked_at IS NULL
  RETURNING invitation_hash`;

const READ_SESSION = `
  SELECT session_hash, business_id, connectors, expires_at, revoked_at
    FROM growthwise_connector_sessions
   WHERE session_hash = $1`;

const REVOKE_INVITATION = `
  UPDATE growthwise_connector_invitations
     SET revoked_at = $2
   WHERE invitation_hash = $1 AND revoked_at IS NULL AND used_at IS NULL
  RETURNING invitation_hash`;

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function failure(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function hash(value, code) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{64}$/.test(clean)) throw failure(code);
  return clean;
}

function businessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) || clean.length > 80) throw failure("INVALID_BUSINESS_ID");
  return clean;
}

function connectorList(value) {
  if (!Array.isArray(value)) throw failure("INVALID_CONNECTORS");
  const clean = [...new Set(value)].sort();
  if (clean.length === 0 || clean.some((item) => !ALLOWED_CONNECTORS.has(item))) throw failure("INVALID_CONNECTORS");
  return clean;
}

function date(value, code) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw failure(code);
  return parsed;
}

function safeSession(row) {
  return {
    business_id: row.business_id,
    connectors: [...row.connectors],
    expires_at: new Date(row.expires_at),
  };
}

export function createConnectorStore({ getPool = netlifyPool } = {}) {
  async function createInvitation(input = {}) {
    const values = [
      hash(input.invitationHash, "INVALID_INVITATION_HASH"),
      businessId(input.businessId),
      connectorList(input.connectors),
      date(input.expiresAt, "INVALID_INVITATION_EXPIRY"),
    ];
    try {
      const result = await (await getPool()).query(INSERT_INVITATION, values);
      return result.rows[0];
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("INVITATION_CREATE_FAILED", error);
    }
  }

  async function redeemInvitation(input = {}) {
    const invitationHash = hash(input.invitationHash, "INVALID_INVITATION_HASH");
    const sessionHash = hash(input.sessionHash, "INVALID_SESSION_HASH");
    const redeemedAt = date(input.now, "INVALID_REDEMPTION_TIME");
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = (await client.query(LOCK_INVITATION, [invitationHash])).rows[0];
      const expiresAt = invitation?.expires_at ? new Date(invitation.expires_at) : null;
      if (!invitation || invitation.revoked_at || invitation.used_at || !expiresAt
        || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= redeemedAt.getTime()) {
        throw failure("INVITATION_INVALID");
      }
      const connectors = connectorList(invitation.connectors);
      const sessionExpiresAt = new Date(redeemedAt.getTime() + SESSION_TTL_MS);
      await client.query(INSERT_SESSION, [sessionHash, businessId(invitation.business_id), connectors, sessionExpiresAt]);
      const marked = await client.query(MARK_USED, [invitationHash, redeemedAt]);
      if (!marked.rows[0]) throw failure("INVITATION_INVALID");
      await client.query("COMMIT");
      return { business_id: invitation.business_id, connectors, expires_at: sessionExpiresAt };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve primary error */ }
      if (error?.message === "INVITATION_INVALID") throw error;
      throw failure("INVITATION_REDEEM_FAILED", error);
    } finally {
      client.release();
    }
  }

  async function authorizeSession(input = {}) {
    const sessionHash = hash(input.sessionHash, "INVALID_SESSION_HASH");
    const id = input.businessId == null ? null : businessId(input.businessId);
    if (input.connector != null && !ALLOWED_CONNECTORS.has(input.connector)) throw failure("SESSION_INVALID");
    const checkedAt = date(input.now, "INVALID_SESSION_TIME");
    let row;
    try {
      row = (await (await getPool()).query(READ_SESSION, [sessionHash])).rows[0];
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("SESSION_READ_FAILED", error);
    }
    const expiresAt = row?.expires_at ? new Date(row.expires_at) : null;
    if (!row || (id && row.business_id !== id) || row.revoked_at || !Array.isArray(row.connectors)
      || (input.connector && !row.connectors.includes(input.connector)) || !expiresAt || !Number.isFinite(expiresAt.getTime())
      || expiresAt.getTime() <= checkedAt.getTime()) throw failure("SESSION_INVALID");
    return safeSession(row);
  }

  async function revokeInvitation(input = {}) {
    const invitationHash = hash(input.invitationHash, "INVALID_INVITATION_HASH");
    const revokedAt = date(input.now, "INVALID_REVOCATION_TIME");
    try {
      const result = await (await getPool()).query(REVOKE_INVITATION, [invitationHash, revokedAt]);
      return result.rows[0] ?? null;
    } catch (error) {
      if (String(error?.message || "").startsWith("INVALID_")) throw error;
      throw failure("INVITATION_REVOKE_FAILED", error);
    }
  }

  return { createInvitation, redeemInvitation, authorizeSession, revokeInvitation };
}
