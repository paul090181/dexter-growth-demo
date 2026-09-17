// TEMPORARY ACCEPTANCE HARNESS — REMOVE BEFORE MERGE.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createInstagramCrypto } from "./_instagram-crypto.mjs";
import { createInstagramStore } from "./_instagram-store.mjs";

function env(name) { return globalThis.Netlify?.env?.get(name) ?? process.env[name]; }
function safeEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || expected.length === 0) return false;
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers,
  } });
}
function acceptanceCrypto() {
  return createInstagramCrypto({
    stateSecrets: { current: { id: "acceptance-state-v1", key: "synthetic-acceptance-state-key" } },
    bindingSecrets: { current: { id: "acceptance-binding-v1", key: "synthetic-acceptance-binding-key" } },
    credentialKeys: { current: { id: "acceptance-credential-v1", key: Buffer.alloc(32, 29).toString("base64url") } },
  });
}
function requireCheck(value) { if (!value) throw new Error("ACCEPTANCE_CHECK_FAILED"); }

export async function runDatabaseAcceptance({ pool }) {
  const checks = [];
  const runPrefix = `instagram-acceptance-${randomUUID()}-`;
  const transactionKey = `${runPrefix}claim`;
  const tenantA = `${runPrefix}tenant-a`; const tenantB = `${runPrefix}tenant-b`;
  const rollbackTenant = `${runPrefix}rollback`; const accountId = `${runPrefix}account`;
  const tokenOne = `${runPrefix}token-one`; const tokenTwo = `${runPrefix}token-two`;
  const store = createInstagramStore({ getPool: async () => pool, crypto: acceptanceCrypto() });
  let activeCheck = "migration_compatibility";
  try {
    const schema = (await pool.query(`SELECT
      to_regclass('public.instagram_oauth_transactions') IS NOT NULL AS transactions_exists,
      to_regclass('public.instagram_credentials') IS NOT NULL AS credentials_exists,
      EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.conrelid=to_regclass('public.instagram_oauth_transactions') AND c.contype='p' AND cardinality(c.conkey)=1 AND a.attname='transaction_key') AS transaction_primary_key,
      EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.conrelid=to_regclass('public.instagram_credentials') AND c.contype='p' AND cardinality(c.conkey)=1 AND a.attname='business_id') AS credential_primary_key,
      EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey) WHERE c.conrelid=to_regclass('public.instagram_credentials') AND c.contype='u' AND a.attname='account_binding_key' AND cardinality(c.conkey)=1) AS credential_unique,
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=to_regclass('public.instagram_oauth_transactions') AND tgname='instagram_oauth_transaction_identity_immutable' AND NOT tgisinternal) AS identity_immutable`)).rows[0];
    requireCheck(Object.values(schema).every(value => value === true)); checks.push({ name: activeCheck, status: "PASS" });

    activeCheck = "one_time_claim";
    await store.createTransaction({ transactionKey, businessId: tenantA, returnDestinationId: "growthwise-dev", expiresAt: new Date(Date.now() + 600000) });
    const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimTransaction({ transactionKey })));
    requireCheck(claims.filter(Boolean).length === 1 && claims.find(Boolean)?.business_id === tenantA);
    requireCheck(await store.claimTransaction({ transactionKey }) === null); checks.push({ name: activeCheck, status: "PASS" });

    const credential = { accountId, businessId: tenantA, payload: { account_id: accountId, access_token: tokenOne }, username: "acceptance_only", lastVerifiedAt: new Date() };
    activeCheck = "cross_tenant_ownership";
    await store.connectCredential(credential);
    let conflict = false; try { await store.connectCredential({ ...credential, businessId: tenantB }); } catch (error) { conflict = error?.message === "ACCOUNT_ALREADY_CONNECTED"; }
    requireCheck(conflict && await store.readCredential({ businessId: tenantB }) === null);
    let databaseConflict = false;
    try { await pool.query(`INSERT INTO instagram_credentials (business_id, account_binding_key, encrypted_credential, encryption_key_version, status) SELECT $1, account_binding_key, encrypted_credential, encryption_key_version, status FROM instagram_credentials WHERE business_id=$2`, [tenantB, tenantA]); }
    catch (error) { databaseConflict = error?.code === "23505"; }
    requireCheck(databaseConflict); checks.push({ name: activeCheck, status: "PASS" });

    activeCheck = "same_owner_reconnect";
    const before = await store.readCredential({ businessId: tenantA });
    await store.connectCredential({ ...credential, payload: { account_id: accountId, access_token: tokenTwo } });
    const after = await store.readCredential({ businessId: tenantA });
    requireCheck(before.account_binding_key === after.account_binding_key && JSON.stringify(before.encrypted_credential) !== JSON.stringify(after.encrypted_credential));
    checks.push({ name: activeCheck, status: "PASS" });

    activeCheck = "transactional_rollback";
    let rolledBack = false; try { await store.connectCredential({ ...credential, businessId: rollbackTenant, accountId: `${runPrefix}rollback-account`, transactionKey: `${runPrefix}missing`, consumedAt: new Date() }); } catch { rolledBack = true; }
    requireCheck(rolledBack && await store.readCredential({ businessId: rollbackTenant }) === null); checks.push({ name: activeCheck, status: "PASS" });

    activeCheck = "encrypted_persistence";
    const persisted = (await pool.query("SELECT encrypted_credential FROM instagram_credentials WHERE business_id=$1", [tenantA])).rows[0];
    requireCheck(persisted && !JSON.stringify(persisted).includes(tokenOne) && !JSON.stringify(persisted).includes(tokenTwo));
    checks.push({ name: activeCheck, status: "PASS" });
    return { ok: true, checks };
  } catch {
    checks.push({ name: activeCheck, status: "FAIL" });
    return { ok: false, checks };
  } finally {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM instagram_credentials WHERE business_id LIKE $1", [`${runPrefix}%`]);
      await client.query("DELETE FROM instagram_oauth_transactions WHERE transaction_key LIKE $1", [`${runPrefix}%`]);
      await client.query("COMMIT");
    } catch {
      try { await client.query("ROLLBACK"); } catch { /* raw cleanup details are deliberately discarded */ }
      throw new Error("ACCEPTANCE_CLEANUP_FAILED");
    } finally { client.release(); }
  }
}

export function createInstagramDatabaseAcceptanceHandler(options = {}) {
  const getEnv = options.env ?? env;
  const run = options.run ?? (async () => {
    const { getDatabase } = await import("@netlify/database");
    return runDatabaseAcceptance({ pool: getDatabase().pool });
  });
  return async function handler(request) {
    if (getEnv("CONTEXT") !== "deploy-preview") return new Response(null, { status: 404 });
    if (request.method !== "POST") return json(405, { error: "Method not allowed." }, { allow: "POST" });
    if (getEnv("GROWTHWISE_DATABASE_ACCEPTANCE_ENABLED") !== "yes") return new Response(null, { status: 404 });
    if (!safeEqual(request.headers.get("x-growthwise-key"), getEnv("GROWTHWISE_ADMIN_KEY"))) return json(401, { error: "Invalid GrowthWise access code." });
    try { return json(200, await run()); }
    catch { return json(503, { ok: false, checks: [{ name: "database_acceptance", status: "FAIL" }] }); }
  };
}

export default createInstagramDatabaseAcceptanceHandler();
