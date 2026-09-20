import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createInstagramStore } from "../../netlify/functions/_instagram-store.mjs";
import { createInstagramCrypto } from "../../netlify/functions/_instagram-crypto.mjs";

function memoryPool(now = new Date("2026-09-17T12:00:00Z")) {
  const rows = new Map();
  const calls = [];
  return {
    rows,
    calls,
    async query(text, values) {
      calls.push({ text, values });
      if (/INSERT INTO instagram_oauth_transactions/.test(text)) {
        if (rows.has(values[0])) throw Object.assign(new Error("duplicate"), { code: "23505" });
        const row = { transaction_key: values[0], business_id: values[1], return_destination_id: values[2], status: "pending", expires_at: values[3] };
        rows.set(values[0], row);
        return { rows: [{ ...row }] };
      }
      if (/UPDATE instagram_oauth_transactions/.test(text)) {
        const row = rows.get(values[0]);
        if (!row || row.status !== "pending" || row.expires_at <= now) return { rows: [] };
        row.status = "processing";
        return { rows: [{ ...row }] };
      }
      throw new Error("unexpected query");
    },
  };
}

const expires = new Date("2026-09-17T12:10:00Z");
function store(pool) { return createInstagramStore({ getPool: async () => pool }); }

function testCrypto(stateKey = "state-secret-at-least-16", bindingKey = "binding-secret-at-least-16") {
  return createInstagramCrypto({
    stateSecrets: { current: { id: "state-v1", key: stateKey } },
    bindingSecrets: { current: { id: "bind-v1", key: bindingKey } },
    credentialKeys: { current: { id: "enc-v1", key: Buffer.alloc(32, 7).toString("base64url") } },
  });
}

function credentialPool({ failWrite = false, failCommit = false } = {}) {
  const rows = new Map();
  const calls = [];
  let staged;
  let released = 0;
  const client = {
    async query(text, values) {
      calls.push({ text, values });
      if (text === "BEGIN") { staged = new Map(rows); return { rows: [] }; }
      if (text === "ROLLBACK") { staged = undefined; return { rows: [] }; }
      if (text === "COMMIT") {
        if (failCommit) throw new Error("commit failed");
        rows.clear(); for (const [key, row] of staged) rows.set(key, row);
        staged = undefined; return { rows: [] };
      }
      if (/INSERT INTO instagram_credentials/.test(text)) {
        if (failWrite) throw new Error("write failed");
        const existingBusiness = staged.get(values[0]);
        if (existingBusiness && !values[9].includes(existingBusiness.account_binding_key)) return { rows: [] };
        const row = {
          business_id: values[0], account_binding_key: values[1],
          encrypted_credential: JSON.parse(values[2]), encryption_key_version: values[3],
          status: values[4], token_expires_at: values[5], username: values[6], display_name: values[7],
        };
        staged.set(values[0], row);
        return { rows: [{ ...row }] };
      }
      throw new Error("unexpected client query");
    },
    release() { released += 1; },
  };
  return {
    rows, calls,
    get released() { return released; },
    async connect() { return client; },
    async query(text, values) {
      calls.push({ text, values });
      if (/FROM instagram_credentials/.test(text)) {
        const row = rows.get(values[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      throw new Error("unexpected pool query");
    },
  };
}

function credentialStore(pool, crypto = testCrypto()) {
  return createInstagramStore({ getPool: async () => pool, crypto });
}

const credentialInput = (businessId = "tenant-a", accountId = "ig-123", token = "SYNTHETIC_ACCESS_TOKEN_DO_NOT_LEAK") => ({
  businessId, accountId, payload: { account_id: accountId, access_token: token },
  username: "safe_name", displayName: "Safe Name", tokenExpiresAt: expires,
});

test("pending OAuth transaction can be claimed exactly once and callback replay fails", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "hash-1", businessId: "tenant-a", returnDestinationId: "growthwise", expiresAt: expires });
  assert.equal((await database.claimTransaction({ transactionKey: "hash-1" })).business_id, "tenant-a");
  assert.equal(await database.claimTransaction({ transactionKey: "hash-1" }), null);
});

test("expired transaction cannot be claimed", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "expired", businessId: "tenant-a", returnDestinationId: "growthwise", expiresAt: new Date("2026-09-17T11:59:59Z") });
  assert.equal(await database.claimTransaction({ transactionKey: "expired" }), null);
});

test("consumed transaction cannot be claimed", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "used", businessId: "tenant-a", returnDestinationId: "growthwise", expiresAt: expires });
  pool.rows.get("used").status = "consumed_success";
  assert.equal(await database.claimTransaction({ transactionKey: "used" }), null);
});

test("two simultaneous claim attempts produce exactly one logical winner", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "race", businessId: "tenant-a", returnDestinationId: "growthwise", expiresAt: expires });
  const results = await Promise.all([
    database.claimTransaction({ transactionKey: "race" }),
    database.claimTransaction({ transactionKey: "race" }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});

test("tenant and return destination are server-stored and cannot be altered while claiming", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "immutable", businessId: "tenant-a", returnDestinationId: "fixed-return", expiresAt: expires });
  const row = await database.claimTransaction({ transactionKey: "immutable" });
  assert.equal(row.business_id, "tenant-a");
  assert.equal(row.return_destination_id, "fixed-return");
  assert.equal(pool.calls.at(-1).values.length, 1);
});

test("queries are parameterized and never contain fixture secrets", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "state-hash-sentinel", businessId: "tenant-secret", returnDestinationId: "return-secret", expiresAt: expires });
  await database.claimTransaction({ transactionKey: "state-hash-sentinel" });
  for (const call of pool.calls) {
    assert.match(call.text, /\$1/);
    assert.doesNotMatch(call.text, /state-hash-sentinel|tenant-secret|return-secret|authorization-code|access-token/);
  }
});

test("derived-key collision retries with a fresh state and never persists raw state", async () => {
  const pool = memoryPool();
  const database = store(pool);
  await database.createTransaction({ transactionKey: "duplicate-hash", businessId: "tenant-a", returnDestinationId: "growthwise", expiresAt: expires });
  const generated = [
    { state: "raw-state-one", nonceHash: "duplicate-hash" },
    { state: "raw-state-two", nonceHash: "fresh-hash" },
  ];
  const result = await database.createTransactionWithFreshState({
    createState: () => generated.shift(), businessId: "tenant-a", returnDestinationId: "growthwise", expiresAt: expires,
  });
  assert.deepEqual(result, { state: "raw-state-two" });
  assert.equal(pool.rows.has("fresh-hash"), true);
  assert.equal(JSON.stringify([...pool.rows.values()]).includes("raw-state"), false);
});

test("malformed generated state fails before inserting a transaction", async () => {
  for (const generated of [null, {}, { state: "", nonceHash: "hash" }, { state: "raw-state", nonceHash: "" }]) {
    const pool = memoryPool();
    const database = store(pool);
    await assert.rejects(
      database.createTransactionWithFreshState({
        createState: () => generated,
        businessId: "tenant-a",
        returnDestinationId: "growthwise",
        expiresAt: expires,
      }),
      /INVALID_OAUTH_TRANSACTION/,
    );
    assert.equal(pool.calls.length, 0);
    assert.equal(pool.rows.size, 0);
  }
});

test("migration prevents tenant and return destination mutation", async () => {
  const migration = await readFile(
    new URL("../../netlify/database/migrations/20260917173000_instagram-oauth/migration.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /NEW\.business_id IS DISTINCT FROM OLD\.business_id/);
  assert.match(migration, /NEW\.return_destination_id IS DISTINCT FROM OLD\.return_destination_id/);
  assert.match(migration, /BEFORE UPDATE ON instagram_oauth_transactions/);
});

test("same Instagram account can bind independently to multiple tenants", async () => {
  const pool = credentialPool();
  const database = credentialStore(pool);
  await database.connectCredential(credentialInput("tenant-a", "ig-123", "SYNTHETIC_TOKEN_A"));
  await database.connectCredential(credentialInput("tenant-b", "ig-123", "SYNTHETIC_TOKEN_B"));
  assert.equal(pool.rows.size, 2);
  assert.equal(pool.rows.get("tenant-a").account_binding_key, pool.rows.get("tenant-b").account_binding_key);
  assert.notEqual(
    pool.rows.get("tenant-a").encrypted_credential.ciphertext,
    pool.rows.get("tenant-b").encrypted_credential.ciphertext,
  );
  assert.equal(
    (await database.readDecryptedCredential({ businessId: "tenant-a", accountId: "ig-123" })).payload.access_token,
    "SYNTHETIC_TOKEN_A",
  );
  assert.equal(
    (await database.readDecryptedCredential({ businessId: "tenant-b", accountId: "ig-123" })).payload.access_token,
    "SYNTHETIC_TOKEN_B",
  );
});

test("credential creation remains transactional per tenant", async () => {
  const pool = credentialPool();
  await credentialStore(pool).connectCredential(credentialInput());
  assert.deepEqual(
    pool.calls.slice(0, 3).map(({ text }) => text === "BEGIN" || text === "COMMIT" ? text : "WRITE"),
    ["BEGIN", "WRITE", "COMMIT"],
  );
  assert.equal(pool.rows.get("tenant-a").status, "active");
});

test("failed credential write does not leave a valid connection", async () => {
  const pool = credentialPool({ failWrite: true });
  await assert.rejects(credentialStore(pool).connectCredential(credentialInput()), /CREDENTIAL_CONNECT_FAILED/);
  assert.equal(pool.rows.size, 0);
  assert.equal(pool.calls.at(-1).text, "ROLLBACK");
});

test("failed binding or commit does not leave a valid credential", async () => {
  const pool = credentialPool({ failCommit: true });
  await assert.rejects(credentialStore(pool).connectCredential(credentialInput()), /CREDENTIAL_CONNECT_FAILED/);
  assert.equal(pool.rows.size, 0);
  assert.equal(pool.calls.at(-1).text, "ROLLBACK");
});

test("reconnect by the owning tenant preserves ownership and replaces ciphertext", async () => {
  const pool = credentialPool();
  const database = credentialStore(pool);
  await database.connectCredential(credentialInput("tenant-a", "ig-123", "SYNTHETIC_TOKEN_ONE"));
  const first = pool.rows.get("tenant-a");
  await database.connectCredential(credentialInput("tenant-a", "ig-123", "SYNTHETIC_TOKEN_TWO"));
  const second = pool.rows.get("tenant-a");
  assert.equal(second.account_binding_key, first.account_binding_key);
  assert.notEqual(second.encrypted_credential.ciphertext, first.encrypted_credential.ciphertext);
  await assert.rejects(database.connectCredential(credentialInput("tenant-a", "ig-456")), /ACCOUNT_REBIND_FORBIDDEN/);
});

test("cross-tenant credential reads fail closed", async () => {
  const pool = credentialPool();
  const database = credentialStore(pool);
  await database.connectCredential(credentialInput("tenant-a"));
  assert.equal(await database.readCredential({ businessId: "tenant-b" }), null);
  assert.equal(await database.readDecryptedCredential({ businessId: "tenant-a", accountId: "ig-other" }), null);
});

test("encrypted credential round trip succeeds and plaintext token is never persisted", async () => {
  const pool = credentialPool();
  const database = credentialStore(pool);
  const input = credentialInput();
  await database.connectCredential(input);
  const saved = pool.rows.get("tenant-a");
  assert.equal(JSON.stringify(saved).includes(input.payload.access_token), false);
  assert.deepEqual((await database.readDecryptedCredential({ businessId: "tenant-a", accountId: "ig-123" })).payload, input.payload);
});

test("modified ciphertext and wrong tenant or account AAD cannot decrypt", async () => {
  const crypto = testCrypto();
  const encrypted = crypto.encryptCredential({ businessId: "tenant-a", accountId: "ig-123", payload: { access_token: "synthetic" } });
  encrypted.ciphertext = `${encrypted.ciphertext.slice(0, -1)}${encrypted.ciphertext.endsWith("A") ? "B" : "A"}`;
  assert.throws(() => crypto.decryptCredential({ businessId: "tenant-a", accountId: "ig-123", encryptedToken: encrypted }), /CREDENTIAL_DECRYPT_FAILED/);
  const valid = crypto.encryptCredential({ businessId: "tenant-a", accountId: "ig-123", payload: { access_token: "synthetic" } });
  assert.throws(() => crypto.decryptCredential({ businessId: "tenant-b", accountId: "ig-123", encryptedToken: valid }), /CREDENTIAL_DECRYPT_FAILED/);
  assert.throws(() => crypto.decryptCredential({ businessId: "tenant-a", accountId: "ig-456", encryptedToken: valid }), /CREDENTIAL_DECRYPT_FAILED/);
});

test("state-secret rotation does not affect account-binding keys", () => {
  assert.equal(testCrypto("state-secret-number-one").accountBindingKey("ig-123"), testCrypto("state-secret-number-two").accountBindingKey("ig-123"));
});

test("binding-secret rotation lets the owning tenant migrate its binding without releasing ownership", async () => {
  const pool = credentialPool();
  const oldCrypto = testCrypto("state-secret-at-least-16", "old-binding-secret-at-least-16");
  await credentialStore(pool, oldCrypto).connectCredential(credentialInput());
  const oldBinding = pool.rows.get("tenant-a").account_binding_key;
  const rotated = createInstagramCrypto({
    stateSecrets: { current: { id: "state-v1", key: "state-secret-at-least-16" } },
    bindingSecrets: {
      current: { id: "bind-v2", key: "new-binding-secret-at-least-16" },
      previous: [{ id: "bind-v1", key: "old-binding-secret-at-least-16" }],
    },
    credentialKeys: { current: { id: "enc-v1", key: Buffer.alloc(32, 7).toString("base64url") } },
  });
  await credentialStore(pool, rotated).connectCredential(credentialInput("tenant-a", "ig-123", "ROTATED_SYNTHETIC_TOKEN"));
  assert.notEqual(pool.rows.get("tenant-a").account_binding_key, oldBinding);
  assert.deepEqual((await credentialStore(pool, rotated).readDecryptedCredential({ businessId: "tenant-a", accountId: "ig-123" })).payload.access_token, "ROTATED_SYNTHETIC_TOKEN");
});

test("binding-secret rotation preserves tenant isolation when an Instagram account is shared", async () => {
  const pool = credentialPool();
  const oldCrypto = testCrypto("state-secret-at-least-16", "old-binding-secret-at-least-16");
  await credentialStore(pool, oldCrypto).connectCredential(
    credentialInput("tenant-a", "ig-123", "SYNTHETIC_TOKEN_A"),
  );
  const rotated = createInstagramCrypto({
    stateSecrets: { current: { id: "state-v1", key: "state-secret-at-least-16" } },
    bindingSecrets: {
      current: { id: "bind-v2", key: "new-binding-secret-at-least-16" },
      previous: [{ id: "bind-v1", key: "old-binding-secret-at-least-16" }],
    },
    credentialKeys: { current: { id: "enc-v1", key: Buffer.alloc(32, 7).toString("base64url") } },
  });
  const rotatedStore = credentialStore(pool, rotated);
  await rotatedStore.connectCredential(
    credentialInput("tenant-b", "ig-123", "SYNTHETIC_TOKEN_B"),
  );
  assert.deepEqual([...pool.rows.keys()].sort(), ["tenant-a", "tenant-b"]);
  assert.equal(
    (await credentialStore(pool, oldCrypto).readDecryptedCredential({ businessId: "tenant-a", accountId: "ig-123" })).payload.access_token,
    "SYNTHETIC_TOKEN_A",
  );
  assert.equal(
    (await rotatedStore.readDecryptedCredential({ businessId: "tenant-b", accountId: "ig-123" })).payload.access_token,
    "SYNTHETIC_TOKEN_B",
  );
});

test("credential transaction always releases its checked-out client", async () => {
  const success = credentialPool();
  await credentialStore(success).connectCredential(credentialInput());
  assert.equal(success.released, 1);
  const failure = credentialPool({ failWrite: true });
  await assert.rejects(credentialStore(failure).connectCredential(credentialInput()));
  assert.equal(failure.released, 1);
});

test("failed OAuth success finalization rolls back the credential write", async () => {
  const calls = [];
  let released = false;
  let stagedCredential = false;
  let activeCredential = false;
  const client = {
    async query(text) {
      calls.push(text);
      if (text === "BEGIN") return { rows: [] };
      if (text === "ROLLBACK") { stagedCredential = false; return { rows: [] }; }
      if (/SELECT business_id/.test(text)) return { rows: [] };
      if (/INSERT INTO instagram_credentials/.test(text)) { stagedCredential = true; return { rows: [{ business_id: "tenant-a" }] }; }
      if (/UPDATE instagram_oauth_transactions/.test(text)) return { rows: [] };
      if (text === "COMMIT") { activeCredential = stagedCredential; throw new Error("must not commit"); }
      throw new Error("unexpected query");
    },
    release() { released = true; },
  };
  const pool = { connect: async () => client };
  await assert.rejects(
    credentialStore(pool).connectCredential({
      ...credentialInput(), transactionKey: "derived-transaction-key", consumedAt: new Date("2026-09-17T12:00:00Z"),
    }),
    /OAUTH_TRANSACTION_FINISH_FAILED/,
  );
  assert.equal(calls.includes("COMMIT"), false);
  assert.equal(calls.at(-1), "ROLLBACK");
  assert.equal(stagedCredential, false);
  assert.equal(activeCredential, false);
  assert.equal(released, true);
});

test("credential migrations keep one row per business while allowing shared Instagram accounts", async () => {
  const initialMigrationUrl = new URL("../../netlify/database/migrations/20260917173000_instagram-oauth/migration.sql", import.meta.url);
  const sharedAccountMigrationUrl = new URL("../../netlify/database/migrations/20260920095500_allow-shared-instagram-accounts/migration.sql", import.meta.url);
  const initialMigration = await readFile(initialMigrationUrl, "utf8");
  const sharedAccountMigration = await readFile(sharedAccountMigrationUrl, "utf8");
  assert.match(initialMigrationUrl.pathname, /\/netlify\/database\/migrations\/\d+_[a-z0-9-]+\/migration\.sql$/);
  assert.match(sharedAccountMigrationUrl.pathname, /\/netlify\/database\/migrations\/\d+_[a-z0-9-]+\/migration\.sql$/);
  assert.match(initialMigration, /business_id text PRIMARY KEY/);
  assert.match(initialMigration, /account_binding_key text UNIQUE NOT NULL/);
  assert.match(initialMigration, /encrypted_credential jsonb NOT NULL/);
  assert.match(sharedAccountMigration, /DROP CONSTRAINT IF EXISTS instagram_credentials_account_binding_key_key/);
});

test("database migrations use Netlify's numbered directory layout", async () => {
  const migrationsUrl = new URL("../../netlify/database/migrations/", import.meta.url);
  const entries = await readdir(migrationsUrl, { withFileTypes: true });
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.isDirectory(), true, `${entry.name} must be a migration directory`);
    assert.match(entry.name, /^\d+_[a-z0-9-]+$/);
    assert.deepEqual(await readdir(new URL(`${entry.name}/`, migrationsUrl)), ["migration.sql"]);
  }
});

test("preview schema inspection fails closed without unsafe missing-relation casts", async () => {
  const acceptance = await readFile(
    new URL("../integration/instagram-database.test.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(acceptance, /::regclass/);
  assert.match(acceptance, /to_regclass\('public\.instagram_oauth_transactions'\)/);
  assert.match(acceptance, /column_record\.attname = 'transaction_key'/);
  assert.match(acceptance, /column_record\.attname = 'business_id'/);
  assert.match(acceptance, /column_record\.attname = 'account_binding_key'/);
  assert.ok((acceptance.match(/cardinality\(constraint_record\.conkey\) = 1/g) ?? []).length >= 3);
});
