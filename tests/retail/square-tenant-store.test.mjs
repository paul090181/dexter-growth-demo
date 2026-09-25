import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createSquareCrypto } from "../../netlify/functions/_square-crypto.mjs";
import { createSquareStore } from "../../netlify/functions/_square-store.mjs";

function testCrypto(bindingKey = "square-binding-secret-at-least-16") {
  return createSquareCrypto({
    bindingSecrets: { current: { id: "bind-v1", key: bindingKey } },
    credentialKeys: {
      current: {
        id: "enc-v1",
        key: Buffer.alloc(32, 11).toString("base64url"),
      },
    },
  });
}

function memoryPool() {
  const rows = new Map();
  const bindings = new Map();
  const calls = [];

  return {
    rows,
    calls,
    async query(text, values) {
      calls.push({ text, values });

      if (/INSERT INTO square_credentials/.test(text)) {
        const [businessId, binding, encryptedJson, keyVersion, environment, status,
          tokenExpiresAt, displayName, lastVerifiedAt, permittedBindings] = values;

        const owner = bindings.get(binding);
        if (owner && owner !== businessId) {
          throw Object.assign(new Error("duplicate binding"), { code: "23505" });
        }

        const existing = rows.get(businessId);
        if (existing && !permittedBindings.includes(existing.account_binding_key)) {
          return { rows: [] };
        }

        if (existing) bindings.delete(existing.account_binding_key);

        const row = {
          business_id: businessId,
          account_binding_key: binding,
          encrypted_credential: JSON.parse(encryptedJson),
          encryption_key_version: keyVersion,
          environment,
          status,
          token_expires_at: tokenExpiresAt,
          display_name: displayName,
          last_verified_at: lastVerifiedAt,
        };
        rows.set(businessId, row);
        bindings.set(binding, businessId);
        return { rows: [{ ...row }] };
      }

      if (/DELETE FROM square_credentials/.test(text)) {
        const row = rows.get(values[0]);
        if (!row) return { rows: [] };
        rows.delete(values[0]);
        bindings.delete(row.account_binding_key);
        return { rows: [{ business_id: values[0] }] };
      }

      if (/UPDATE square_credentials/.test(text)) {
        const row = rows.get(values[0]);
        if (!row) return { rows: [] };
        row.status = values[1];
        row.last_verified_at = values[2];
        return { rows: [{ ...row }] };
      }

      if (/FROM square_credentials/.test(text)) {
        const row = rows.get(values[0]);
        return { rows: row ? [{ ...row }] : [] };
      }

      throw new Error("unexpected query");
    },
  };
}

function input(businessId = "tenant-a", accountId = "merchant-123", token = "SYNTHETIC_SQUARE_TOKEN_DO_NOT_LEAK") {
  return {
    businessId,
    accountId,
    environment: "sandbox",
    payload: { account_id: accountId, access_token: token },
    displayName: "Test Square Merchant",
    lastVerifiedAt: new Date("2026-09-25T14:00:00Z"),
  };
}

function store(pool, crypto = testCrypto()) {
  return createSquareStore({ getPool: async () => pool, crypto });
}

test("Square credential is encrypted and bound to one tenant", async () => {
  const pool = memoryPool();
  const database = store(pool);
  const value = input();

  await database.connectCredential(value);

  const saved = pool.rows.get("tenant-a");
  assert.equal(saved.environment, "sandbox");
  assert.equal(JSON.stringify(saved).includes(value.payload.access_token), false);

  const decrypted = await database.readDecryptedCredential({ businessId: "tenant-a" });
  assert.deepEqual(decrypted.payload, value.payload);
});

test("another tenant cannot read or reuse the same Square merchant binding", async () => {
  const pool = memoryPool();
  const database = store(pool);

  await database.connectCredential(input("tenant-a", "merchant-123", "TOKEN_A"));
  assert.equal(await database.readCredential({ businessId: "tenant-b" }), null);

  await assert.rejects(
    database.connectCredential(input("tenant-b", "merchant-123", "TOKEN_B")),
    /ACCOUNT_ALREADY_BOUND/,
  );
  assert.equal(pool.rows.has("tenant-b"), false);
});

test("owning tenant may reconnect the same Square merchant but not silently rebind to another", async () => {
  const pool = memoryPool();
  const database = store(pool);

  await database.connectCredential(input("tenant-a", "merchant-123", "TOKEN_ONE"));
  const firstCiphertext = pool.rows.get("tenant-a").encrypted_credential.ciphertext;

  await database.connectCredential(input("tenant-a", "merchant-123", "TOKEN_TWO"));
  const secondCiphertext = pool.rows.get("tenant-a").encrypted_credential.ciphertext;
  assert.notEqual(firstCiphertext, secondCiphertext);

  await assert.rejects(
    database.connectCredential(input("tenant-a", "merchant-456", "TOKEN_THREE")),
    /ACCOUNT_REBIND_FORBIDDEN/,
  );
});

test("Square ciphertext cannot decrypt under a different tenant", () => {
  const crypto = testCrypto();
  const encrypted = crypto.encryptCredential({
    businessId: "tenant-a",
    accountId: "merchant-123",
    payload: { access_token: "synthetic" },
  });
  const binding = crypto.accountBindingKey("merchant-123");

  assert.throws(
    () => crypto.decryptCredential({
      businessId: "tenant-b",
      accountBindingKey: binding,
      encryptedToken: encrypted,
    }),
    /CREDENTIAL_DECRYPT_FAILED/,
  );
});

test("Square credential health and disconnect remain tenant scoped", async () => {
  const pool = memoryPool();
  const database = store(pool);

  await database.connectCredential(input());
  const checkedAt = new Date("2026-09-25T14:05:00Z");
  const updated = await database.markCredentialStatus({
    businessId: "tenant-a",
    status: "needs_attention",
    lastVerifiedAt: checkedAt,
  });
  assert.equal(updated.status, "needs_attention");
  assert.equal(updated.last_verified_at, checkedAt);

  assert.equal((await database.disconnectCredential({ businessId: "tenant-a" })).business_id, "tenant-a");
  assert.equal(await database.readCredential({ businessId: "tenant-a" }), null);
});

test("Square SQL stays parameterized and never embeds fixture credentials", async () => {
  const pool = memoryPool();
  const database = store(pool);
  const value = input();

  await database.connectCredential(value);

  for (const call of pool.calls) {
    assert.doesNotMatch(call.text, /SYNTHETIC_SQUARE_TOKEN_DO_NOT_LEAK|merchant-123|tenant-a/);
    if (!/^(BEGIN|COMMIT|ROLLBACK)$/.test(call.text)) assert.match(call.text, /\$1/);
  }
});

test("Square credential migration enforces one row per business and unique merchant binding", async () => {
  const migration = await readFile(
    new URL("../../netlify/database/migrations/20260925150000_square-tenant-credentials/migration.sql", import.meta.url),
    "utf8",
  );

  assert.match(migration, /business_id TEXT PRIMARY KEY/i);
  assert.match(migration, /account_binding_key TEXT UNIQUE NOT NULL/i);
  assert.match(migration, /encrypted_credential JSONB NOT NULL/i);
  assert.match(migration, /environment IN \('sandbox', 'production'\)/i);
  assert.match(migration, /status IN \('active', 'needs_attention', 'revoked'\)/i);
});
