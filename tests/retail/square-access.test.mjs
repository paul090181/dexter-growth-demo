import test from "node:test";
import assert from "node:assert/strict";
import { getSquareAccess, SquareAccessError } from "../../netlify/functions/_square-access.mjs";
import { SQUARE_OAUTH_SCOPES } from "../../netlify/functions/_square-oauth.mjs";

function credential({
  status = "active",
  expiresAt = new Date("2026-10-01T00:00:00Z"),
} = {}) {
  return {
    business_id: "tenant-a",
    environment: "sandbox",
    status,
    token_expires_at: expiresAt,
    payload: {
      access_token: "access-one",
      refresh_token: "refresh-one",
      merchant_id: "MERCHANT123",
      scopes: [...SQUARE_OAUTH_SCOPES],
    },
  };
}

test("Square access reuses a healthy tenant token without touching OAuth config", async () => {
  let configCalls = 0;
  const result = await getSquareAccess({
    businessId: "tenant-a",
    now: new Date("2026-09-25T14:00:00Z"),
    crypto: {},
    store: {
      readDecryptedCredential: async ({ businessId }) => {
        assert.equal(businessId, "tenant-a");
        return credential();
      },
    },
    config: () => { configCalls += 1; throw new Error("must not configure"); },
  });

  assert.equal(result.accessToken, "access-one");
  assert.equal(result.environment, "sandbox");
  assert.equal(result.refreshed, false);
  assert.equal(configCalls, 0);
});

test("Square access refreshes an expiring token and persists it to the same tenant and merchant", async () => {
  const updates = [];
  const result = await getSquareAccess({
    businessId: "tenant-a",
    now: new Date("2026-09-25T14:00:00Z"),
    crypto: {},
    store: {
      readDecryptedCredential: async () => credential({
        expiresAt: new Date("2026-09-25T14:02:00Z"),
      }),
      updateCredentialToken: async (input) => {
        updates.push(input);
        return { business_id: input.businessId };
      },
      markCredentialStatus: async () => {
        throw new Error("must not mark attention");
      },
    },
    config: () => ({
      environment: "sandbox",
      applicationId: "sandbox-app",
      applicationSecret: "synthetic-secret",
    }),
    refreshToken: async (input) => {
      assert.equal(input.refreshToken, "refresh-one");
      assert.equal(input.environment, "sandbox");
      return {
        accessToken: "access-two",
        refreshToken: "refresh-two",
        merchantId: "MERCHANT123",
        tokenType: "bearer",
        expiresAt: new Date("2026-10-25T14:00:00Z"),
      };
    },
  });

  assert.equal(result.accessToken, "access-two");
  assert.equal(result.refreshed, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].businessId, "tenant-a");
  assert.equal(updates[0].accountId, "MERCHANT123");
  assert.equal(updates[0].payload.refresh_token, "refresh-two");
});

test("Square access fails closed and marks attention if refresh changes merchant identity", async () => {
  const statuses = [];
  await assert.rejects(
    getSquareAccess({
      businessId: "tenant-a",
      now: new Date("2026-09-25T14:00:00Z"),
      crypto: {},
      store: {
        readDecryptedCredential: async () => credential({
          expiresAt: new Date("2026-09-25T14:02:00Z"),
        }),
        updateCredentialToken: async () => {
          throw new Error("must not update");
        },
        markCredentialStatus: async (input) => {
          statuses.push(input);
          return input;
        },
      },
      config: () => ({
        environment: "sandbox",
        applicationId: "sandbox-app",
        applicationSecret: "synthetic-secret",
      }),
      refreshToken: async () => ({
        accessToken: "access-two",
        refreshToken: "refresh-two",
        merchantId: "DIFFERENT_MERCHANT",
        tokenType: "bearer",
        expiresAt: new Date("2026-10-25T14:00:00Z"),
      }),
    }),
    (error) => error instanceof SquareAccessError && error.code === "refresh_failed",
  );
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].businessId, "tenant-a");
  assert.equal(statuses[0].status, "needs_attention");
});

test("Square access distinguishes not-connected from invalid stored credentials", async () => {
  await assert.rejects(
    getSquareAccess({
      businessId: "tenant-a",
      crypto: {},
      store: { readDecryptedCredential: async () => null },
    }),
    (error) => error instanceof SquareAccessError && error.code === "not_connected",
  );

  await assert.rejects(
    getSquareAccess({
      businessId: "tenant-a",
      crypto: {},
      store: {
        readDecryptedCredential: async () => credential({ status: "needs_attention" }),
      },
    }),
    (error) => error instanceof SquareAccessError && error.code === "needs_attention",
  );
});
