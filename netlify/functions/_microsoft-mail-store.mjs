const INSERT_TRANSACTION = `
  INSERT INTO microsoft_mail_oauth_transactions
    (transaction_key, business_id, mailbox_context, status, expires_at)
  VALUES ($1, $2, $3, 'pending', $4)
  RETURNING transaction_key, business_id, mailbox_context, status, expires_at, created_at
`;

const CLAIM_TRANSACTION = `
  UPDATE microsoft_mail_oauth_transactions
  SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  WHERE transaction_key = $1
    AND status = 'pending'
    AND expires_at > CURRENT_TIMESTAMP
  RETURNING transaction_key, business_id, mailbox_context, status, expires_at, created_at
`;

const FINISH_TRANSACTION = `
  UPDATE microsoft_mail_oauth_transactions
  SET status = $2, consumed_at = $3, updated_at = CURRENT_TIMESTAMP
  WHERE transaction_key = $1
    AND status = 'processing'
  RETURNING transaction_key, status
`;

const CONNECT_CREDENTIAL = `
  INSERT INTO microsoft_mail_credentials
    (business_id, account_binding_key, encrypted_credential, encryption_key_version,
     status, token_expires_at, email_address, display_name, mailbox_context,
     consent_recorded_at, last_verified_at)
  VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (business_id) DO UPDATE SET
    account_binding_key = EXCLUDED.account_binding_key,
    encrypted_credential = EXCLUDED.encrypted_credential,
    encryption_key_version = EXCLUDED.encryption_key_version,
    status = EXCLUDED.status,
    token_expires_at = EXCLUDED.token_expires_at,
    email_address = EXCLUDED.email_address,
    display_name = EXCLUDED.display_name,
    mailbox_context = EXCLUDED.mailbox_context,
    consent_recorded_at = EXCLUDED.consent_recorded_at,
    last_verified_at = EXCLUDED.last_verified_at,
    updated_at = CURRENT_TIMESTAMP
  WHERE microsoft_mail_credentials.account_binding_key = ANY($12::text[])
  RETURNING business_id, account_binding_key, status, token_expires_at,
    email_address, display_name, mailbox_context, consent_recorded_at, last_verified_at
`;

const FINALIZE_CONNECTED_TRANSACTION = `
  UPDATE microsoft_mail_oauth_transactions
  SET status = 'consumed_success', consumed_at = $3, updated_at = CURRENT_TIMESTAMP
  WHERE transaction_key = $1
    AND business_id = $2
    AND status = 'processing'
  RETURNING transaction_key
`;

const READ_CREDENTIAL = `
  SELECT business_id, account_binding_key, encrypted_credential, encryption_key_version,
    status, token_expires_at, email_address, display_name, mailbox_context,
    consent_recorded_at, created_at, updated_at, last_verified_at
  FROM microsoft_mail_credentials
  WHERE business_id = $1
`;

const DELETE_CREDENTIAL = `
  DELETE FROM microsoft_mail_credentials
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

function validMailboxContext(value) {
  return value === "business" || value === "personal_acknowledged";
}

function validateTransaction(input) {
  if (!input || typeof input.transactionKey !== "string" || !input.transactionKey
    || !validBusinessId(input.businessId) || !validMailboxContext(input.mailboxContext)) {
    throw failure("INVALID_OAUTH_TRANSACTION");
  }
  const expiresAt = input.expiresAt instanceof Date ? input.expiresAt : new Date(input.expiresAt);
  if (!Number.isFinite(expiresAt.getTime())) throw failure("INVALID_OAUTH_TRANSACTION");
  return { ...input, expiresAt };
}

export function createMicrosoftMailStore({ getPool = netlifyPool, crypto } = {}) {
  async function query(text, values) {
    return (await getPool()).query(text, values);
  }

  async function createTransaction(input) {
    const value = validateTransaction(input);
    try {
      const result = await query(INSERT_TRANSACTION, [
        value.transactionKey,
        value.businessId,
        value.mailboxContext,
        value.expiresAt,
      ]);
      return result.rows[0];
    } catch (error) {
      if (error?.code === "23505") throw failure("OAUTH_TRANSACTION_COLLISION", error);
      throw failure("OAUTH_TRANSACTION_CREATE_FAILED", error);
    }
  }

  async function createTransactionWithFreshState({
    createState, businessId, mailboxContext, expiresAt, maxAttempts = 3,
  }) {
    if (typeof createState !== "function" || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw failure("INVALID_OAUTH_TRANSACTION");
    }
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const generated = createState();
      if (!generated || typeof generated.state !== "string" || !generated.state
        || typeof generated.nonceHash !== "string" || !generated.nonceHash) {
        throw failure("INVALID_OAUTH_TRANSACTION");
      }
      try {
        await createTransaction({
          transactionKey: generated.nonceHash,
          businessId,
          mailboxContext,
          expiresAt,
        });
        return { state: generated.state };
      } catch (error) {
        if (error.message !== "OAUTH_TRANSACTION_COLLISION") throw error;
      }
    }
    throw failure("OAUTH_TRANSACTION_CREATE_FAILED");
  }

  async function claimTransaction({ transactionKey } = {}) {
    if (typeof transactionKey !== "string" || !transactionKey) {
      throw failure("INVALID_OAUTH_TRANSACTION");
    }
    try {
      const result = await query(CLAIM_TRANSACTION, [transactionKey]);
      return result.rows[0] ?? null;
    } catch (error) {
      throw failure("OAUTH_TRANSACTION_CLAIM_FAILED", error);
    }
  }

  async function finishTransaction({ transactionKey, status, now = new Date() } = {}) {
    if (typeof transactionKey !== "string" || !transactionKey
      || !["consumed_success", "consumed_failed", "consumed_denied"].includes(status)
      || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
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
      || typeof input.accountId !== "string" || !input.accountId
      || !input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)
      || !validMailboxContext(input.mailboxContext)
      || typeof input.emailAddress !== "string" || !input.emailAddress.includes("@")
      || !(input.consentRecordedAt instanceof Date) || !Number.isFinite(input.consentRecordedAt.getTime())
      || !(input.lastVerifiedAt instanceof Date) || !Number.isFinite(input.lastVerifiedAt.getTime())
      || typeof input.transactionKey !== "string" || !input.transactionKey
      || !(input.consumedAt instanceof Date) || !Number.isFinite(input.consumedAt.getTime())) {
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

    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(CONNECT_CREDENTIAL, [
        input.businessId,
        accountBindingKey,
        JSON.stringify(encrypted),
        encrypted.key_version,
        input.status ?? "active",
        input.tokenExpiresAt ?? null,
        input.emailAddress.toLowerCase(),
        input.displayName ?? null,
        input.mailboxContext,
        input.consentRecordedAt,
        input.lastVerifiedAt,
        permittedBindingKeys,
      ]);
      if (!result.rows[0]) throw failure("ACCOUNT_REBIND_FORBIDDEN");

      const finalized = await client.query(FINALIZE_CONNECTED_TRANSACTION, [
        input.transactionKey,
        input.businessId,
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
    createTransactionWithFreshState,
    claimTransaction,
    finishTransaction,
    connectCredential,
    readCredential,
    readDecryptedCredential,
    disconnectCredential,
  };
}

export const microsoftMailDatabase = createMicrosoftMailStore;
