import test from "node:test";
import assert from "node:assert/strict";
import { createSquareConnectionHandler } from "../../netlify/functions/square-connection.mjs";

function request({
  method = "GET",
  url = "https://example.test/.netlify/functions/square-connection?business_id=tenant-a",
  tenantKey = "test-key",
} = {}) {
  return new Request(url, {
    method,
    headers: tenantKey ? { "x-growthwise-tenant-key": tenantKey } : {},
  });
}

function handler({
  row = null,
  authorized = true,
  authorizeBusinessId = "tenant-a",
  readError = null,
} = {}) {
  const calls = [];
  const value = createSquareConnectionHandler({
    tenantStore: { readTenantAuth: async () => null },
    authorize: async (_request, input) => {
      calls.push({ kind: "auth", input });
      return authorized
        ? { ok: true, businessId: authorizeBusinessId, via: "tenant" }
        : { ok: false, businessId: null, via: "none" };
    },
    squareStore: {
      readCredential: async (input) => {
        calls.push({ kind: "read", input });
        if (readError) throw readError;
        return row;
      },
    },
    now: () => new Date("2026-09-25T14:15:00Z"),
  });
  return { value, calls };
}

test("Square connection status requires exact tenant authorization", async () => {
  const denied = handler({ authorized: false });
  const deniedResponse = await denied.value(request());
  assert.equal(deniedResponse.status, 401);
  assert.equal(denied.calls.some((call) => call.kind === "read"), false);

  const wrongTenant = handler({ authorizeBusinessId: "tenant-b" });
  const wrongResponse = await wrongTenant.value(request());
  assert.equal(wrongResponse.status, 401);
  assert.equal(wrongTenant.calls.some((call) => call.kind === "read"), false);
});

test("Square connection status reads only the authenticated business ID", async () => {
  const connected = handler({
    row: {
      business_id: "tenant-a",
      status: "active",
      display_name: "Tenant A Square",
      account_binding_key: "must-not-leak",
      encrypted_credential: { ciphertext: "must-not-leak" },
    },
  });

  const response = await connected.value(request());
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body, {
    business_id: "tenant-a",
    state: "Connected",
    checked_at: "2026-09-25T14:15:00.000Z",
    account: { display_name: "Tenant A Square" },
    action: "",
  });
  assert.deepEqual(
    connected.calls.find((call) => call.kind === "read").input,
    { businessId: "tenant-a" },
  );
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
});

test("Square connection reports Not Connected without exposing another tenant", async () => {
  const missing = handler({ row: null });
  const response = await missing.value(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.state, "Not Connected");
  assert.equal(body.account, null);
});

test("Square connection reports Needs Attention safely", async () => {
  for (const status of ["needs_attention", "revoked"]) {
    const current = handler({
      row: {
        business_id: "tenant-a",
        status,
        display_name: "Tenant A Square",
        encrypted_credential: { ciphertext: "secret-ciphertext" },
      },
    });
    const response = await current.value(request());
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.state, "Needs Attention");
    assert.deepEqual(body.account, { display_name: "Tenant A Square" });
    assert.equal(JSON.stringify(body).includes("secret-ciphertext"), false);
  }
});

test("Square connection rejects malformed selectors and non-GET methods", async () => {
  const current = handler();

  for (const url of [
    "https://example.test/.netlify/functions/square-connection",
    "https://example.test/.netlify/functions/square-connection?business_id=tenant-a&business_id=tenant-b",
    "https://example.test/.netlify/functions/square-connection?business_id=tenant-a&extra=1",
    "https://example.test/.netlify/functions/square-connection?business_id=Tenant_A",
    "https://example.test/not-square?business_id=tenant-a",
  ]) {
    const response = await current.value(request({ url }));
    assert.equal(response.status, 400);
  }

  const method = await current.value(request({ method: "POST" }));
  assert.equal(method.status, 405);
  assert.equal(method.headers.get("allow"), "GET");
});

test("Square connection fails closed when credential storage is unavailable", async () => {
  const current = handler({ readError: new Error("database unavailable") });
  const response = await current.value(request());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Square connection could not be checked.",
  });
});
