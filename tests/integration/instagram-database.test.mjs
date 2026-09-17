import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInstagramCrypto } from "../../netlify/functions/_instagram-crypto.mjs";
import { createInstagramStore } from "../../netlify/functions/_instagram-store.mjs";

const deploymentContext = `${process.env.CONTEXT ?? ""} ${process.env.NETLIFY_CONTEXT ?? ""}`.trim();
const productionLikeContext = /prod/i.test(deploymentContext);
const databaseGuard = process.env.INSTAGRAM_DATABASE_TEST_GUARD;
const enabled = !productionLikeContext
  && process.env.INSTAGRAM_DATABASE_INTEGRATION === "isolated-non-production"
  && process.env.NETLIFY_DATABASE_ACCEPT_DESTRUCTIVE_TESTS === "yes"
  && typeof process.env.NETLIFY_DB_URL === "string"
  && process.env.NETLIFY_DB_URL.length > 0
  && typeof databaseGuard === "string"
  && databaseGuard.length > 0;

const skipReason = [
  "NOT TESTABLE: an explicitly approved isolated non-production database is not configured.",
  "Set INSTAGRAM_DATABASE_INTEGRATION=isolated-non-production,",
  "NETLIFY_DATABASE_ACCEPT_DESTRUCTIVE_TESTS=yes, NETLIFY_DB_URL, and INSTAGRAM_DATABASE_TEST_GUARD",
  "to run this destructive acceptance test; production-like CONTEXT/NETLIFY_CONTEXT values are always rejected.",
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

test("isolated PostgreSQL enforces one-time claims and unique account ownership", { skip: enabled ? false : skipReason }, async () => {
  const { getDatabase } = await import("@netlify/database");
  const pool = getDatabase().pool;
  const migration = await readFile(
    new URL("../../netlify/database/migrations/20260917173000_instagram_oauth.sql", import.meta.url),
    "utf8",
  );
  const setupClient = await pool.connect();
  let setupTransactionOpen = false;

  try {
    // A separately provisioned database-side sentinel is required before any DDL.
    // The test never creates, changes, or drops this guard table.
    const guards = await setupClient.query(
      "SELECT marker = $1 AS matches FROM growthwise_integration_test_guard",
      [databaseGuard],
    );
    assert.equal(guards.rows.length, 1, "isolated database guard must contain exactly one row");
    assert.equal(guards.rows[0].matches, true, "isolated database guard does not match");

    // Refuse to reuse application objects rather than deleting unknown data.
    const existing = await setupClient.query(`
      SELECT to_regclass('public.instagram_oauth_transactions') AS transactions,
             to_regclass('public.instagram_credentials') AS credentials,
             to_regprocedure('public.reject_instagram_oauth_transaction_identity_change()') AS identity_function
    `);
    assert.equal(existing.rows[0].transactions, null, "isolated database already contains OAuth transactions");
    assert.equal(existing.rows[0].credentials, null, "isolated database already contains Instagram credentials");
    assert.equal(existing.rows[0].identity_function, null, "isolated database already contains the identity function");
    await setupClient.query("BEGIN");
    setupTransactionOpen = true;
    await setupClient.query(migration);
    await setupClient.query("COMMIT");
    setupTransactionOpen = false;
  } catch (error) {
    if (setupTransactionOpen) await setupClient.query("ROLLBACK");
    throw error;
  } finally {
    setupClient.release();
  }

  try {
    const store = createInstagramStore({ getPool: async () => pool, crypto: integrationCrypto() });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await store.createTransaction({
      transactionKey: "integration-claim",
      businessId: "integration-tenant-a",
      returnDestinationId: "growthwise-dev",
      expiresAt,
    });
    const claims = await Promise.all(Array.from(
      { length: 20 },
      () => store.claimTransaction({ transactionKey: "integration-claim" }),
    ));
    assert.equal(claims.filter(Boolean).length, 1, "exactly one concurrent claim must win");
    assert.equal(await store.claimTransaction({ transactionKey: "integration-claim" }), null, "replay must fail closed");

    const credential = {
      accountId: "integration-instagram-account",
      payload: { account_id: "integration-instagram-account", access_token: "SYNTHETIC_INTEGRATION_TOKEN" },
      username: "integration_only",
      lastVerifiedAt: new Date(),
    };
    await store.connectCredential({ ...credential, businessId: "integration-tenant-a" });
    await assert.rejects(
      store.connectCredential({ ...credential, businessId: "integration-tenant-b" }),
      /ACCOUNT_ALREADY_CONNECTED/,
    );
    assert.equal(await store.readCredential({ businessId: "integration-tenant-b" }), null);
    const persisted = await store.readCredential({ businessId: "integration-tenant-a" });
    assert.equal(JSON.stringify(persisted).includes(credential.payload.access_token), false);
  } finally {
    const cleanupClient = await pool.connect();
    try {
      await cleanupClient.query("DROP TABLE IF EXISTS instagram_credentials");
      await cleanupClient.query("DROP TABLE IF EXISTS instagram_oauth_transactions");
      await cleanupClient.query("DROP FUNCTION IF EXISTS reject_instagram_oauth_transaction_identity_change()");
    } finally {
      cleanupClient.release();
      await pool.end();
    }
  }
});
