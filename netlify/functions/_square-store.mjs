const INSERT_TRANSACTION = `
  INSERT INTO square_oauth_transactions
    (transaction_key, business_id, environment, status, expires_at)
  VALUES ($1, $2, $3, 'pending', $4)
  RETURNING transaction_key, business_id, environment, status, expires_at, created_at
`;

const CLAIM_TRANSACTION = `
  UPDATE square_oauth_transactions
     SET status = 'processing',
         processing_started_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
   WHERE transaction_key = $1
     AND status = 'pending'
     AND expires_at > CURRENT_TIMESTAMP
  RETURNING transaction_key, business_id, environment, status, expires_at, created_at
`;

const FINISH_TRANSACTION = `
  UPDATE square_oauth_transactions
     SET status = $2,
         consumed_at = $3,
         updated_at = CURRENT_TIMESTAMP
   WHERE transaction_key = $1
     AND status = 'processing'
  RETURNING transaction_key, status
`;

const CONNECT_CREDENTIAL = `
  INSERT INTO square_credentials
    (business_id, account_binding_key, encrypted_credential, encryption_key_version,
     environment, status, token_expires_at, display_name, last_verified_at)
  VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (business_id) DO UPDATE SET
    account_binding_key = EXCLUDED.account_binding_key,
    encrypted_credential = EXCLUDED.encrypted_credential,
    encryption_key_version = EXCLUDED.encryption_key_version,
    environment = EXCLUDED.environment,
    status = EXCLUDED.status,
    token_expires_at = EXCLUDED.token_expires_at,
    display_name = EXCLUDED.display_name,
    last_verified_at = EXCLUDED.last_verified_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE square_credentials.account_binding_key = ANY($10::text[])
  RETURNING business_id, account_binding_key, encryption_key_version,
    environment, status, token_expires_at, display_name,
    created_at, updated_at, last_verified_at
`;

const FINALIZE_CONNECTED_TRANSACTION = `
  UPDATE square_oauth_transactions
     SET status = 'consumed_success',
         consumed_at = $4,
         updated_at = CURRENT_TIMESTAMP
   WHERE transaction_key = $1
     AND business_id = $2
     AND environment = $3
     AND status = 'processing'
  RETURNING transaction_key
`;

const READ_CREDENTIAL = `
  SELECT business_id, account_binding_key, encrypted_credential,
    encryption_key_version, environment, status, token_expires_at,
    display_name, created_at, updated_at, last_verified_at
  FROM square_credentials
  WHERE business_id = $1
`;

const UPDATE_STATUS = `
  UPDATE square_credentials
     SET status = $2,
         last_verified_at = $3,
         updated_at = CURRENT_TIMESTAMP
   WHERE business_id = $1
  RETURNING business_id, environment, status, display_name, last_verified_at
`;

const DELETE_CREDENTIAL = `
  DELETE FROM square_credentials
   WHERE business_id = $1
  RETURNING business_id
`;

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function failure(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

function validBusinessId(value) {
  return typeof value === "string"
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && value.length <= 80;
}

function validEnvironment(value) {
  return value === "sandbox" || value === "production";
}

function validDateOrNull(value) {
  return value === null || value === undefined
    || (value instanceof Date && Number.isFinite(value.getTime()));
}

function validTransactionKey(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function createSquareStore({ getPool = netlifyPool, crypto } = {}) {
  async function query(text, values) {
    return (await getPool()).query(text, values);
  }

  async function createTransaction(input = {}) {
    if (!validTransactionKey(input.transactionKey)
      || !validBusinessId(input.businessId)
      || !validEnvironment(input.environment)
      || !(input.expiresAt instanceof Date)
      || !Number.isFinite(input.expiresAt.getTime())) {
      throw failure("INVALID_OAUTH_TRANSACTION");
    }
    try {
      const result = await query(INSERT_TRANSACTION, [
        input.transactionKey,
        input.businessId,
        input.environment,
        input.expiresAt,
      ]);
      return result.rows[0];
    } catch (error) {
      if (error?.code === "23505") throw failure("OAUTH_TRANSACTION_COLLISION", error);
      throw failure("OAUTH_TRANSACTION_CREATE_FAILED", error);
    }
  }

  async function createTransactionWithFreshState({
    createState,
    businessId,
    environment,
    expiresAt,
    maxAttempts = 3,
  } = {}) {
    if (typeof createState !== "function"
      || !validBusinessId(businessId)
      || !validEnvironment(environment)
      || !(expiresAt instanceof Date)
      || !Number.isFinite(expiresAt.getTime())
      || !Number.isInteger(maxAttempts)
      || maxAttempts < 1
      || maxAttempts > 10) {
      throw failure("INVALID_OAUTH_TRANSACTION");
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const generated = createState();
      if (!generated
        || typeof generated.state !== "string"
        || !generated.state
        || !validTransactionKey(generated.transactionKey)) {
        throw failure("INVALID_OAUTH_TRANSACTION");
      }
      try {
        await createTransaction({
          transactionKey: generated.transactionKey,
          businessId,
          environment,
          expiresAt,
        });
        return { state: generated.state };
      } catch (error) {
        if (error?.message !== "OAUTH_TRANSACTION_COLLISION") throw error;
      }
    }
    throw failure("OAUTH_TRANSACTION_CREATE_FAILED");
  }

  async function claimTransaction({ transactionKey } = {}) {
    if (!validTransactionKey(transactionKey)) throw failure("INVALID_OAUTH_TRANSACTION");
    try {
      const result = await query(CLAIM_TRANSACTION, [transactionKey]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw failure("OAUTH_TRANSACTION_CLAIM_FAILED", error);
    }
  }

  async function finishTransaction({
    transactionKey,
    status,
    now = new Date(),
  } = {}) {
    if (!validTransactionKey(transactionKey)
      || !["consumed_failed", "consumed_denied"].includes(status)
      || !(now instanceof Date)
      || !Number.isFinite(now.getTime())) {
      throw failure("INVALID_OAUTH_TRANSACTION");
    }
    try {
      const result = await query(FINISH_TRANSACTION, [transactionKey, status, now]);
      if (!result.rows[0]) throw failure("OAUTH_TRANSACTION_FINISH_FAILED");
      return result.rows[0];
    } catch (error) {
      if (error?.message === "OAUTH_TRANSACTION_FINISH_FAILED") throw error;
      throw failure("OAUTH_TRANSACTION_FINISH_FAILED", error);
    }
  }

  async function connectCredential(input = {}) {
    if (!validBusinessId(input.businessId)
      || typeof input.accountId !== "string" || !input.accountId || input.accountId.length > 512
      || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)
      || !validEnvironment(input.environment)
      || !validDateOrNull(input.tokenExpiresAt)
      || !validDateOrNull(input.lastVerifiedAt)
      || (input.status !== undefined
        && !["active", "needs_attention", "revoked"].includes(input.status))
      || (input.transactionKey !== undefined
        && (!validTransactionKey(input.transactionKey)
          || !(input.consumedAt instanceof Date)
          || !Number.isFinite(input.consumedAt.getTime())))) {
      throw failure("INVALID_CREDENTIAL");
    }
    if (!crypto?.accountBindingKey || !crypto?.accountBindingKeys || !crypto?.encryptCredential) {
      throw failure("CREDENTIAL_CONFIGURATION_FAILED");
    }

    const accountBindingKey = crypto.accountBindingKey(input.accountId);
    const permittedBindingKeys = crypto.accountBindingKeys(input.accountId);
    const encrypted = crypto.encryptCredential({
      businessId: input.businessId,
      accountId: input.accountId,
      payload: input.payload,
    });
    const values = [
      input.businessId,
      accountBindingKey,
      JSON.stringify(encrypted),
      encrypted.key_version,
      input.environment,
      input.status ?? "active",
      input.tokenExpiresAt ?? null,
      input.displayName ?? null,
      input.lastVerifiedAt ?? null,
      permittedBindingKeys,
    ];

    if (input.transactionKey === undefined) {
      try {
        const result = await query(CONNECT_CREDENTIAL, values);
        if (!result.rows[0]) throw failure("ACCOUNT_REBIND_FORBIDDEN");
        return result.rows[0];
      } catch (error) {
        if (error?.message === "ACCOUNT_REBIND_FORBIDDEN") throw error;
        if (error?.code === "23505") throw failure("ACCOUNT_ALREADY_BOUND", error);
        throw failure("CREDENTIAL_CONNECT_FAILED", error);
      }
    }

    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(CONNECT_CREDENTIAL, values);
      if (!result.rows[0]) throw failure("ACCOUNT_REBIND_FORBIDDEN");

      const finalized = await client.query(FINALIZE_CONNECTED_TRANSACTION, [
        input.transactionKey,
        input.businessId,
        input.environment,
        input.consumedAt,
      ]);
      if (!finalized.rows[0]) throw failure("OAUTH_TRANSACTION_FINISH_FAILED");

      await client.query("COMMIT");
      return result.rows[0];
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (["ACCOUNT_REBIND_FORBIDDEN", "OAUTH_TRANSACTION_FINISH_FAILED"].includes(error?.message)) {
        throw error;
      }
      if (error?.code === "23505") throw failure("ACCOUNT_ALREADY_BOUND", error);
      throw failure("CREDENTIAL_CONNECT_FAILED", error);
    } finally {
      client.release();
    }
  }

  async function readCredential({ businessId } = {}) {
    if (!validBusinessId(businessId)) throw failure("INVALID_CREDENTIAL");
    try {
      const result = await query(READ_CREDENTIAL, [businessId]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw failure("CREDENTIAL_READ_FAILED", error);
    }
  }

  async function readDecryptedCredential({ businessId } = {}) {
    if (!crypto?.decryptCredential) throw failure("CREDENTIAL_CONFIGURATION_FAILED");
    const row = await readCredential({ businessId });
    if (!row) return null;
    return {
      ...row,
      payload: crypto.decryptCredential({
        businessId,
        accountBindingKey: row.account_binding_key,
        encryptedToken: row.encrypted_credential,
      }),
    };
  }

  async function markCredentialStatus({
    businessId,
    status,
    lastVerifiedAt = new Date(),
  } = {}) {
    if (!validBusinessId(businessId)
      || !["active", "needs_attention", "revoked"].includes(status)
      || !(lastVerifiedAt instanceof Date)
      || !Number.isFinite(lastVerifiedAt.getTime())) {
      throw failure("INVALID_CREDENTIAL");
    }
    try {
      const result = await query(UPDATE_STATUS, [businessId, status, lastVerifiedAt]);
      if (!result.rows[0]) throw failure("CREDENTIAL_UPDATE_FAILED");
      return result.rows[0];
    } catch (error) {
      if (error?.message === "CREDENTIAL_UPDATE_FAILED") throw error;
      throw failure("CREDENTIAL_UPDATE_FAILED", error);
    }
  }

  async function disconnectCredential({ businessId } = {}) {
    if (!validBusinessId(businessId)) throw failure("INVALID_CREDENTIAL");
    try {
      const result = await query(DELETE_CREDENTIAL, [businessId]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw failure("CREDENTIAL_DELETE_FAILED", error);
    }
  }

  return {
    createTransaction,
    createTransactionWithFreshState,
    claimTransaction,
    finishTransaction,
    connectCredential,
    readCredential,
    readDecryptedCredential,
    markCredentialStatus,
    disconnectCredential,
  };
}
