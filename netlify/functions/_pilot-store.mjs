const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PILOT_SESSION_TTL_MS = SESSION_TTL_MS;

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function failure(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function cleanHash(value, code) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^[a-f0-9]{64}$/.test(clean)) throw failure(code);
  return clean;
}

function cleanBusinessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) || clean.length > 80) {
    throw failure("INVALID_BUSINESS_ID");
  }
  return clean;
}

function cleanDate(value, code) {
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw failure(code);
  return parsed;
}

export function createPilotStore({ getPool = netlifyPool } = {}) {
  return {
    async createInvitation({ invitationHash, businessId, expiresAt } = {}) {
      const values = [
        cleanHash(invitationHash, "INVALID_INVITATION_HASH"),
        cleanBusinessId(businessId),
        cleanDate(expiresAt, "INVALID_INVITATION_EXPIRY"),
      ];
      const result = await (await getPool()).query(
        `INSERT INTO growthwise_pilot_invitations
           (invitation_hash, business_id, expires_at)
         VALUES ($1, $2, $3)
         RETURNING invitation_hash, business_id, expires_at`,
        values,
      );
      return result.rows[0];
    },

    async redeemInvitation({ invitationHash, sessionHash, now } = {}) {
      const inviteHash = cleanHash(invitationHash, "INVALID_INVITATION_HASH");
      const authHash = cleanHash(sessionHash, "INVALID_SESSION_HASH");
      const checkedAt = cleanDate(now, "INVALID_REDEMPTION_TIME");
      const sessionExpiresAt = new Date(checkedAt.getTime() + SESSION_TTL_MS);
      const pool = await getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const invitation = (await client.query(
          `SELECT invitation_hash, business_id, expires_at, consumed_at, revoked_at
             FROM growthwise_pilot_invitations
            WHERE invitation_hash = $1
            FOR UPDATE`,
          [inviteHash],
        )).rows[0];
        const inviteExpiresAt = invitation?.expires_at ? new Date(invitation.expires_at) : null;
        if (!invitation || invitation.consumed_at || invitation.revoked_at || !inviteExpiresAt
          || !Number.isFinite(inviteExpiresAt.getTime()) || inviteExpiresAt.getTime() <= checkedAt.getTime()) {
          throw failure("PILOT_INVITATION_INVALID");
        }
        const id = cleanBusinessId(invitation.business_id);
        await client.query(
          `INSERT INTO growthwise_pilot_sessions
             (session_hash, business_id, expires_at)
           VALUES ($1, $2, $3)`,
          [authHash, id, sessionExpiresAt],
        );
        const consumed = await client.query(
          `UPDATE growthwise_pilot_invitations
              SET consumed_at = $2
            WHERE invitation_hash = $1
              AND consumed_at IS NULL
              AND revoked_at IS NULL
            RETURNING invitation_hash`,
          [inviteHash, checkedAt],
        );
        if (!consumed.rows[0]) throw failure("PILOT_INVITATION_INVALID");
        await client.query("COMMIT");
        return { business_id: id, expires_at: sessionExpiresAt };
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch {}
        if (error?.message === "PILOT_INVITATION_INVALID") throw error;
        throw failure("PILOT_INVITATION_REDEEM_FAILED", error);
      } finally {
        client.release();
      }
    },

    async readBusinessStatus({ businessId, now = new Date() } = {}) {
      const id = cleanBusinessId(businessId);
      const checkedAt = cleanDate(now, "INVALID_STATUS_TIME");
      const pool = await getPool();

      try {
        const [invitationResult, sessionResult, eventResult, feedbackResult] = await Promise.all([
          pool.query(
            `SELECT created_at, expires_at, consumed_at, revoked_at
               FROM growthwise_pilot_invitations
              WHERE business_id = $1
              ORDER BY created_at DESC
              LIMIT 1`,
            [id],
          ),
          pool.query(
            `SELECT created_at, expires_at, revoked_at
               FROM growthwise_pilot_sessions
              WHERE business_id = $1
              ORDER BY created_at DESC
              LIMIT 1`,
            [id],
          ),
          pool.query(
            `SELECT event_name, COUNT(*)::int AS event_count,
                    MIN(created_at) AS first_at, MAX(created_at) AS last_at
               FROM growthwise_pilot_events
              WHERE business_id = $1
              GROUP BY event_name
              ORDER BY event_name ASC`,
            [id],
          ),
          pool.query(
            `SELECT result, COUNT(*)::int AS feedback_count,
                    MAX(created_at) AS last_at
               FROM growthwise_pilot_feedback
              WHERE business_id = $1
              GROUP BY result
              ORDER BY result ASC`,
            [id],
          ),
        ]);

        const invitation = invitationResult.rows[0] ?? null;
        const session = sessionResult.rows[0] ?? null;
        const events = eventResult.rows ?? [];
        const feedback = feedbackResult.rows ?? [];

        return {
          business_id: id,
          checked_at: checkedAt,
          invitation,
          session,
          events,
          feedback,
        };
      } catch (error) {
        throw failure("PILOT_STATUS_READ_FAILED", error);
      }
    },

    async authorizeSession({ sessionHash, businessId, now } = {}) {
      const hash = cleanHash(sessionHash, "INVALID_SESSION_HASH");
      const id = cleanBusinessId(businessId);
      const checkedAt = cleanDate(now, "INVALID_SESSION_TIME");
      const row = (await (await getPool()).query(
        `SELECT session_hash, business_id, expires_at, revoked_at
           FROM growthwise_pilot_sessions
          WHERE session_hash = $1`,
        [hash],
      )).rows[0];
      const expiresAt = row?.expires_at ? new Date(row.expires_at) : null;
      if (!row || row.business_id !== id || row.revoked_at || !expiresAt
        || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= checkedAt.getTime()) {
        throw failure("PILOT_SESSION_INVALID");
      }
      return { business_id: row.business_id, expires_at: expiresAt };
    },
  };
}
