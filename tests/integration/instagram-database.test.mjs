import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createInstagramCrypto } from "../../netlify/functions/_instagram-crypto.mjs";
import { createInstagramStore } from "../../netlify/functions/_instagram-store.mjs";

// Netlify creates an isolated database branch and applies migrations before a
// Deploy Preview runs. This suite deliberately neither reads a database URL nor
// performs DDL; it only accepts that already-migrated preview lifecycle.
const enabled = process.env.CONTEXT === "deploy-preview"
  && process.env.INSTAGRAM_DATABASE_INTEGRATION === "isolated-deploy-preview";
const skipReason = [
  "NOT TESTABLE: an automatically migrated, isolated Deploy Preview database is not available.",
  "Run only with CONTEXT=deploy-preview and INSTAGRAM_DATABASE_INTEGRATION=isolated-deploy-preview.",
].join(" ");

function integrationCrypto() {
  return createInstagramCrypto({
    stateSecrets: { current: { id: "test-state-v1", key: "isolated-integration-state-secret" } },
    bindingSecrets: { current: { id: "test-binding-v1", key: "isolated-integration-binding-secret" } },
    credentialKeys: {
      current: { id: "test-encryption-v1", key: Buffer.alloc(32, 23).toString("base64url") },
    },
  });
}

test("already-migrated Deploy Preview database satisfies the OAuth persistence contract", { skip: enabled ? false : skipReason }, async () => {
  const { getDatabase } = await import("@netlify/database");
  const pool = getDatabase().pool;
  const runPrefix = `instagram-acceptance-${randomUUID()}-`;
  const transactionKey = `${runPrefix}claim`;
  const tenantA = `${runPrefix}tenant-a`;
  const tenantB = `${runPrefix}tenant-b`;
  const rollbackTenant = `${runPrefix}rollback`;
  const accountId = `${runPrefix}professional-account`;
  const syntheticTokenOne = `${runPrefix}token-one`;
  const syntheticTokenTwo = `${runPrefix}token-two`;
  const syntheticTokenThree = `${runPrefix}token-three`;
  const store = createInstagramStore({ getPool: async () => pool, crypto: integrationCrypto() });
  let installedSchema = null;

  try {
    const schema = await pool.query(`
      WITH relations AS (
        SELECT
          to_regclass('public.instagram_oauth_transactions') AS transaction_oid,
          to_regclass('public.instagram_credentials') AS credential_oid
      )
      SELECT
        relations.transaction_oid IS NOT NULL AS transactions_exists,
        relations.credential_oid IS NOT NULL AS credentials_exists,
        EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_attribute column_record
            ON column_record.attrelid = constraint_record.conrelid
           AND column_record.attnum = ANY(constraint_record.conkey)
          WHERE constraint_record.conrelid = relations.transaction_oid
            AND constraint_record.contype = 'p'
            AND column_record.attname = 'transaction_key'
            AND cardinality(constraint_record.conkey) = 1
        ) AS transaction_primary_key,
        EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_attribute column_record
            ON column_record.attrelid = constraint_record.conrelid
           AND column_record.attnum = ANY(constraint_record.conkey)
          WHERE constraint_record.conrelid = relations.credential_oid
            AND constraint_record.contype = 'p'
            AND column_record.attname = 'business_id'
            AND cardinality(constraint_record.conkey) = 1
        ) AS credential_primary_key,
        EXISTS (
          SELECT 1
          FROM pg_constraint constraint_record
          JOIN pg_attribute column_record
            ON column_record.attrelid = constraint_record.conrelid
           AND column_record.attnum = ANY(constraint_record.conkey)
          WHERE constraint_record.conrelid = relations.credential_oid
            AND constraint_record.contype = 'u'
            AND column_record.attname = 'account_binding_key'
            AND cardinality(constraint_record.conkey) = 1
        ) AS credential_unique,
        EXISTS (
          SELECT 1 FROM pg_trigger
          WHERE tgrelid = relations.transaction_oid
            AND tgname = 'instagram_oauth_transaction_identity_immutable'
            AND NOT tgisinternal
        ) AS identity_immutable
      FROM relations
    `);
    installedSchema = schema.rows[0];
    assert.deepEqual(installedSchema, {
      transactions_exists: true,
      credentials_exists: true,
      transaction_primary_key: true,
      credential_primary_key: true,
      credential_unique: false,
      identity_immutable: true,
    });

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await store.createTransaction({
      transactionKey, businessId: tenantA, returnDestinationId: "growthwise-dev", expiresAt,
    });

    const mutationClient = await pool.connect();
    try {
      await mutationClient.query("BEGIN");
      await assert.rejects(
        mutationClient.query(
          "UPDATE instagram_oauth_transactions SET business_id = $1 WHERE transaction_key = $2",
          [tenantB, transactionKey],
        ),
      );
      await mutationClient.query("ROLLBACK");
    } finally {
      mutationClient.release();
    }

    const claims = await Promise.all(Array.from(
      { length: 20 },
      () => store.claimTransaction({ transactionKey }),
    ));
    assert.equal(claims.filter(Boolean).length, 1, "exactly one concurrent claim must win");
    assert.equal(claims.find(Boolean).business_id, tenantA, "the immutable tenant must survive the claim");
    assert.equal(await store.claimTransaction({ transactionKey }), null, "replay must fail closed");

    const credential = {
      accountId,
      payload: { account_id: accountId, access_token: syntheticTokenOne },
      username: "acceptance_only",
      lastVerifiedAt: new Date(),
    };
    const first = await store.connectCredential({ ...credential, businessId: tenantA });
    const shared = await store.connectCredential({
      ...credential,
      businessId: tenantB,
      payload: { account_id: accountId, access_token: syntheticTokenTwo },
    });
    assert.equal(shared.business_id, tenantB);
    assert.equal(shared.account_binding_key, first.account_binding_key);
    assert.notDeepEqual(shared.encrypted_credential, first.encrypted_credential);
    assert.equal(
      (await store.readDecryptedCredential({ businessId: tenantA, accountId })).payload.access_token,
      syntheticTokenOne,
    );
    assert.equal(
      (await store.readDecryptedCredential({ businessId: tenantB, accountId })).payload.access_token,
      syntheticTokenTwo,
    );

    const second = await store.connectCredential({
      ...credential,
      businessId: tenantA,
      payload: { account_id: accountId, access_token: syntheticTokenThree },
    });
    assert.equal(second.business_id, tenantA);
    assert.equal(second.account_binding_key, first.account_binding_key);
    assert.notDeepEqual(second.encrypted_credential, first.encrypted_credential);

    await assert.rejects(
      store.connectCredential({
        ...credential,
        businessId: rollbackTenant,
        accountId: `${runPrefix}rollback-account`,
        transactionKey: `${runPrefix}missing-finalization-target`,
        consumedAt: new Date(),
      }),
      /OAUTH_TRANSACTION_FINISH_FAILED/,
    );
    assert.equal(await store.readCredential({ businessId: rollbackTenant }), null);

    const persisted = await pool.query(
      "SELECT business_id, account_binding_key, encrypted_credential, encryption_key_version, status, username FROM instagram_credentials WHERE business_id = $1",
      [tenantA],
    );
    assert.equal(persisted.rows.length, 1);
    assert.equal(JSON.stringify(persisted.rows[0]).includes(syntheticTokenOne), false);
    assert.equal(JSON.stringify(persisted.rows[0]).includes(syntheticTokenTwo), false);
    assert.equal(JSON.stringify(persisted.rows[0]).includes(syntheticTokenThree), false);
    const persistedShared = await pool.query(
      "SELECT business_id, encrypted_credential FROM instagram_credentials WHERE business_id = $1",
      [tenantB],
    );
    assert.equal(persistedShared.rows.length, 1);
    assert.equal(JSON.stringify(persistedShared.rows[0]).includes(syntheticTokenTwo), false);
  } finally {
    // Cleanup is deliberately row-scoped to this random acceptance-run prefix.
    // It never drops or alters application objects and cannot select other tenants.
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("BEGIN");
      if (installedSchema?.credentials_exists) {
        await cleanupClient.query("DELETE FROM instagram_credentials WHERE business_id LIKE $1", [`${runPrefix}%`]);
      }
      if (installedSchema?.transactions_exists) {
        await cleanupClient.query("DELETE FROM instagram_oauth_transactions WHERE transaction_key LIKE $1", [`${runPrefix}%`]);
      }
      await cleanupClient.query("COMMIT");
    } catch (error) {
      await cleanupClient.query("ROLLBACK");
      throw error;
    } finally {
      cleanupClient.release();
    }
  }
});
