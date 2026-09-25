import test from "node:test";
import assert from "node:assert/strict";
import { createSquareCrypto } from "../../netlify/functions/_square-crypto.mjs";
import { createSquareStore } from "../../netlify/functions/_square-store.mjs";

const transactionKey = "b".repeat(64);

function crypto() {
  return createSquareCrypto({
    stateSecrets: {
      current: { id: "state-v1", key: "square-state-secret-at-least-16" },
    },
    bindingSecrets: {
      current: { id: "bind-v1", key: "square-binding-secret-at-least-16" },
    },
    credentialKeys: {
      current: {
        id: "enc-v1",
        key: Buffer.alloc(32, 21).toString("base64url"),
      },
    },
  });
}

function pool() {
  const transactions = new Map();
  const credentials = new Map();
  const calls = [];
  let stagedCredentials = null;
  let stagedTransactions = null;

  const currentCredentials = () => stagedCredentials ?? credentials;
  const currentTransactions = () => stagedTransactions ?? transactions;

  const execute = async (text, values) => {
    calls.push({ text, values });

    if (text === "BEGIN") {
      stagedCredentials = new Map(credentials);
      stagedTransactions = new Map(
        [...transactions].map(([key, value]) => [key, { ...value }]),
      );
      return { rows: [] };
    }
    if (text === "ROLLBACK") {
      stagedCredentials = null;
      stagedTransactions = null;
      return { rows: [] };
    }
    if (text === "COMMIT") {
      credentials.clear();
      for (const [key, value] of stagedCredentials) credentials.set(key, value);
      transactions.clear();
      for (const [key, value] of stagedTransactions) transactions.set(key, value);
      stagedCredentials = null;
      stagedTransactions = null;
      return { rows: [] };
    }

    if (/INSERT INTO square_oauth_transactions/.test(text)) {
      if (transactions.has(values[0])) {
        throw Object.assign(new Error("duplicate"), { code: "23505" });
      }
      const row = {
        transaction_key: values[0],
        business_id: values[1],
        environment: values[2],
        status: "pending",
        expires_at: values[3],
        created_at: new Date("2026-09-25T14:00:00Z"),
      };
      transactions.set(values[0], row);
      return { rows: [{ ...row }] };
    }

    if (/SET status = 'processing'/.test(text)) {
      const row = transactions.get(values[0]);
      if (!row || row.status !== "pending") return { rows: [] };
      row.status = "processing";
      return { rows: [{ ...row }] };
    }

    if (/SET status = \$2/.test(text)) {
      const row = transactions.get(values[0]);
      if (!row || row.status !== "processing") return { rows: [] };
      row.status = values[1];
      return { rows: [{ transaction_key: values[0], status: row.status }] };
    }

    if (/INSERT INTO square_credentials/.test(text)) {
      const target = currentCredentials();
      const existing = target.get(values[0]);
      if (existing && !values[9].includes(existing.account_binding_key)) return { rows: [] };
      const row = {
        business_id: values[0],
        account_binding_key: values[1],
        encrypted_credential: JSON.parse(values[2]),
        encryption_key_version: values[3],
        environment: values[4],
        status: values[5],
        token_expires_at: values[6],
        display_name: values[7],
        last_verified_at: values[8],
      };
      target.set(values[0], row);
      return { rows: [{ ...row }] };
    }

    if (/SET status = 'consumed_success'/.test(text)) {
      const row = currentTransactions().get(values[0]);
      if (!row
        || row.business_id !== values[1]
        || row.environment !== values[2]
        || row.status !== "processing") {
        return { rows: [] };
      }
      row.status = "consumed_success";
      return { rows: [{ transaction_key: values[0] }] };
    }

    throw new Error(`unexpected query: ${text}`);
  };

  const client = {
    query: execute,
    release() {},
  };

  return {
    transactions,
    credentials,
    calls,
    query: execute,
    connect: async () => client,
  };
}

test("Square OAuth state is one-time and transaction identity is server stored", async () => {
  const dbPool = pool();
  const c = crypto();
  const database = createSquareStore({ getPool: async () => dbPool, crypto: c });
  const generated = c.createState();

  await database.createTransaction({
    transactionKey: generated.transactionKey,
    businessId: "tenant-a",
    environment: "sandbox",
    expiresAt: new Date("2026-09-25T14:40:00Z"),
  });

  const claimed = await database.claimTransaction({
    transactionKey: generated.transactionKey,
  });
  assert.equal(claimed.business_id, "tenant-a");
  assert.equal(claimed.environment, "sandbox");
  assert.equal(
    await database.claimTransaction({ transactionKey: generated.transactionKey }),
    null,
  );
});

test("Square OAuth success stores credential and consumes transaction atomically", async () => {
  const dbPool = pool();
  const c = crypto();
  const database = createSquareStore({ getPool: async () => dbPool, crypto: c });

  await database.createTransaction({
    transactionKey,
    businessId: "tenant-a",
    environment: "sandbox",
    expiresAt: new Date("2026-09-25T14:40:00Z"),
  });
  await database.claimTransaction({ transactionKey });

  await database.connectCredential({
    businessId: "tenant-a",
    accountId: "MERCHANT123",
    environment: "sandbox",
    payload: {
      access_token: "synthetic-access",
      refresh_token: "synthetic-refresh",
      merchant_id: "MERCHANT123",
    },
    status: "active",
    tokenExpiresAt: new Date("2026-10-25T14:00:00Z"),
    displayName: "Second Business",
    lastVerifiedAt: new Date("2026-09-25T14:31:00Z"),
    transactionKey,
    consumedAt: new Date("2026-09-25T14:31:00Z"),
  });

  assert.equal(dbPool.transactions.get(transactionKey).status, "consumed_success");
  assert.equal(dbPool.credentials.get("tenant-a").status, "active");
  assert.equal(
    JSON.stringify(dbPool.credentials.get("tenant-a")).includes("synthetic-access"),
    false,
  );
});

test("Square OAuth cannot finalize a credential into a different tenant", async () => {
  const dbPool = pool();
  const c = crypto();
  const database = createSquareStore({ getPool: async () => dbPool, crypto: c });

  await database.createTransaction({
    transactionKey,
    businessId: "tenant-a",
    environment: "sandbox",
    expiresAt: new Date("2026-09-25T14:40:00Z"),
  });
  await database.claimTransaction({ transactionKey });

  await assert.rejects(
    database.connectCredential({
      businessId: "tenant-b",
      accountId: "MERCHANT123",
      environment: "sandbox",
      payload: { access_token: "synthetic-access" },
      status: "active",
      lastVerifiedAt: new Date("2026-09-25T14:31:00Z"),
      transactionKey,
      consumedAt: new Date("2026-09-25T14:31:00Z"),
    }),
    /OAUTH_TRANSACTION_FINISH_FAILED/,
  );

  assert.equal(dbPool.credentials.has("tenant-b"), false);
  assert.equal(dbPool.transactions.get(transactionKey).status, "processing");
});
