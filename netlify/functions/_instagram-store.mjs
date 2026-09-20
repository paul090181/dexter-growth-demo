const INSERT_TRANSACTION = `
  INSERT INTO instagram_oauth_transactions
    (transaction_key, business_id, return_destination_id, status, expires_at)
  VALUES ($1, $2, $3, 'pending', $4)
  RETURNING transaction_key, business_id, return_destination_id, status, expires_at
`;

const CLAIM_TRANSACTION = `
  UPDATE instagram_oauth_transactions
  SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE transaction_key = $1
    AND status = 'pending'
    AND expires_at > CURRENT_TIMESTAMP
  RETURNING transaction_key, business_id, return_destination_id, status, expires_at
`;

const FINISH_TRANSACTION = `
  UPDATE instagram_oauth_transactions
  SET status = $2, consumed_at = $3, updated_at = CURRENT_TIMESTAMP
  WHERE transaction_key = $1
    AND status = 'processing'
  RETURNING transaction_key, status
`;

const CONNECT_CREDENTIAL = `
  INSERT INTO instagram_credentials
    (business_id, account_binding_key, encrypted_credential, encryption_key_version,
     status, token_expires_at, username, display_name, last_verified_at)
  VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (business_id) DO UPDATE SET
    account_binding_key = EXCLUDED.account_binding_key,
    encrypted_credential = EXCLUDED.encrypted_credential,
    encryption_key_version = EXCLUDED.encryption_key_version,
    status = EXCLUDED.status,
    token_expires_at = EXCLUDED.token_expires_at,
    username = EXCLUDED.username,
    display_name = EXCLUDED.display_name,
    last_verified_at = EXCLUDED.last_verified_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE instagram_credentials.account_binding_key = ANY($10::text[])
  RETURNING business_id, account_binding_key, encrypted_credential,
    encryption_key_version, status, token_expires_at, username, display_name,
    created_at, updated_at, last_verified_at
`;

const FINALIZE_CONNECTED_TRANSACTION = `
  UPDATE instagram_oauth_transactions
  SET status = 'consumed_success', consumed_at = $3, updated_at = CURRENT_TIMESTAMP
  WHERE transaction_key = $1
    AND business_id = $2
    AND status = 'processing'
  RETURNING transaction_key
`;

const READ_CREDENTIAL = `
  SELECT business_id, account_binding_key, encrypted_credential,
    encryption_key_version, status, token_expires_at, username, display_name,
    created_at, updated_at, last_verified_at
  FROM instagram_credentials
  WHERE business_id = $1
`;

const UPDATE_CREDENTIAL_HEALTH = `
  UPDATE instagram_credentials
  SET status = $2, username = $3, display_name = $4,
      last_verified_at = $5, updated_at = CURRENT_TIMESTAMP
  WHERE business_id = $1
  RETURNING business_id, status, username, display_name, last_verified_at
`;

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function safeStoreError(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function validateTransaction(input) {
  if (!input || typeof input.transactionKey !== "string" || !input.transactionKey) {
    throw safeStoreError("INVALID_OAUTH_TRANSACTION");
  }
  if (typeof input.businessId !== "string" || !input.businessId) throw safeStoreError("INVALID_OAUTH_TRANSACTION");
  if (typeof input.returnDestinationId !== "string" || !input.returnDestinationId) {
    throw safeStoreError("INVALID_OAUTH_TRANSACTION");
  }
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) throw safeStoreError("INVALID_OAUTH_TRANSACTION");
  return { ...input, expiresAt };
}

function validateCredential(input) {
  if (!input || typeof input.businessId !== "string" || !input.businessId) throw safeStoreError("INVALID_CREDENTIAL");
  if (typeof input.accountId !== "string" || !input.accountId) throw safeStoreError("INVALID_CREDENTIAL");
  if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) throw safeStoreError("INVALID_CREDENTIAL");
  if (input.status !== undefined && !["active", "needs_attention", "revoked"].includes(input.status)) throw safeStoreError("INVALID_CREDENTIAL");
  if (input.transactionKey !== undefined && (typeof input.transactionKey !== "string" || !input.transactionKey)) throw safeStoreError("INVALID_CREDENTIAL");
  if (input.transactionKey !== undefined && (!(input.consumedAt instanceof Date) || !Number.isFinite(input.consumedAt.getTime()))) throw safeStoreError("INVALID_CREDENTIAL");
  return input;
}

export function createInstagramStore({ getPool = netlifyPool, crypto } = {}) {
  async function query(text, values) {
    const pool = await getPool();
    return pool.query(text, values);
  }

  async function createTransaction(input) {
    const value = validateTransaction(input);
    try {
      const result = await query(INSERT_TRANSACTION, [
        value.transactionKey,
        value.businessId,
        value.returnDestinationId,
        value.expiresAt,
      ]);
      return result.rows[0];
    } catch (error) {
      if (error?.code === "23505") throw safeStoreError("OAUTH_TRANSACTION_COLLISION", error);
      throw safeStoreError("OAUTH_TRANSACTION_CREATE_FAILED", error);
    }
  }

  async function connectCredential(input) {
    const value = validateCredential(input);
    if (!crypto?.accountBindingKey || !crypto?.accountBindingKeys || !crypto?.encryptCredential) throw safeStoreError("CREDENTIAL_CONFIGURATION_FAILED");
    const accountBindingKey = crypto.accountBindingKey(value.accountId);
    const permittedBindingKeys = crypto.accountBindingKeys(value.accountId);
    const encrypted = crypto.encryptCredential({
      businessId: value.businessId,
      accountId: value.accountId,
      payload: value.payload,
    });
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(CONNECT_CREDENTIAL, [
        value.businessId,
        accountBindingKey,
        JSON.stringify(encrypted),
        encrypted.key_version,
        value.status ?? "active",
        value.tokenExpiresAt ?? null,
        value.username ?? null,
        value.displayName ?? null,
        value.lastVerifiedAt ?? null,
        permittedBindingKeys,
      ]);
      if (!result.rows[0]) throw safeStoreError("ACCOUNT_REBIND_FORBIDDEN");
      if (value.transactionKey !== undefined) {
        const finalized = await client.query(FINALIZE_CONNECTED_TRANSACTION, [
          value.transactionKey, value.businessId, value.consumedAt,
        ]);
        if (!finalized.rows[0]) throw safeStoreError("OAUTH_TRANSACTION_FINISH_FAILED");
      }
      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the original safe failure */ }
      if (["ACCOUNT_REBIND_FORBIDDEN", "OAUTH_TRANSACTION_FINISH_FAILED"].includes(error?.message)) throw error;
      throw safeStoreError("CREDENTIAL_CONNECT_FAILED", error);
    } finally {
      client.release();
    }
  }

  async function readCredential({ businessId } = {}) {
    if (typeof businessId !== "string" || !businessId) throw safeStoreError("INVALID_CREDENTIAL");
    try {
      const result = await query(READ_CREDENTIAL, [businessId]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw safeStoreError("CREDENTIAL_READ_FAILED", error);
    }
  }

  async function readDecryptedCredential({ businessId, accountId } = {}) {
    if (!crypto?.accountBindingKeys || !crypto?.decryptCredential) throw safeStoreError("CREDENTIAL_CONFIGURATION_FAILED");
    const row = await readCredential({ businessId });
    if (!row || !crypto.accountBindingKeys(accountId).includes(row.account_binding_key)) return null;
    return {
      ...row,
      payload: crypto.decryptCredential({ businessId, accountId, encryptedToken: row.encrypted_credential }),
    };
  }

  return {
    createTransaction,
    connectCredential,
    readCredential,
    readDecryptedCredential,

    async updateCredentialHealth({ businessId, status, username = null, displayName = null, lastVerifiedAt = null } = {}) {
      if (typeof businessId !== "string" || !businessId
        || !["active", "needs_attention"].includes(status)
        || (lastVerifiedAt !== null && (!(lastVerifiedAt instanceof Date) || !Number.isFinite(lastVerifiedAt.getTime())))) {
        throw safeStoreError("INVALID_CREDENTIAL");
      }
      try {
        const result = await query(UPDATE_CREDENTIAL_HEALTH, [
          businessId, status, username, displayName, lastVerifiedAt,
        ]);
        if (!result.rows[0]) throw safeStoreError("CREDENTIAL_UPDATE_FAILED");
        return result.rows[0];
      } catch (error) {
        if (error?.message === "CREDENTIAL_UPDATE_FAILED") throw error;
        throw safeStoreError("CREDENTIAL_UPDATE_FAILED", error);
      }
    },

    async createTransactionWithFreshState({ createState, businessId, returnDestinationId, expiresAt, maxAttempts = 3 }) {
      if (typeof createState !== "function" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
        throw safeStoreError("INVALID_OAUTH_TRANSACTION");
      }
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const generated = createState();
        if (
          !generated
          || typeof generated.state !== "string"
          || generated.state.length === 0
          || typeof generated.nonceHash !== "string"
          || generated.nonceHash.length === 0
        ) {
          throw safeStoreError("INVALID_OAUTH_TRANSACTION");
        }
        try {
          await createTransaction({
            transactionKey: generated?.nonceHash,
            businessId,
            returnDestinationId,
            expiresAt,
          });
          return { state: generated.state };
        } catch (error) {
          if (error.message !== "OAUTH_TRANSACTION_COLLISION") throw error;
        }
      }
      throw safeStoreError("OAUTH_TRANSACTION_CREATE_FAILED");
    },

    async claimTransaction({ transactionKey } = {}) {
      if (typeof transactionKey !== "string" || !transactionKey) throw safeStoreError("INVALID_OAUTH_TRANSACTION");
      try {
        const result = await query(CLAIM_TRANSACTION, [transactionKey]);
        return result.rows[0] ?? null;
      } catch (error) {
        throw safeStoreError("OAUTH_TRANSACTION_CLAIM_FAILED", error);
      }
    },

    async finishTransaction({ transactionKey, status, now = new Date() } = {}) {
      if (typeof transactionKey !== "string" || !transactionKey
        || !["consumed_success", "consumed_failed", "consumed_denied"].includes(status)
        || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
        throw safeStoreError("INVALID_OAUTH_TRANSACTION");
      }
      try {
        const result = await query(FINISH_TRANSACTION, [transactionKey, status, now]);
        if (!result.rows[0]) throw safeStoreError("OAUTH_TRANSACTION_FINISH_FAILED");
        return result.rows[0];
      } catch (error) {
        if (error?.message === "OAUTH_TRANSACTION_FINISH_FAILED") throw error;
        throw safeStoreError("OAUTH_TRANSACTION_FINISH_FAILED", error);
      }
    },
  };
}

export const instagramDatabase = createInstagramStore;
