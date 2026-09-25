import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeTenantRequest,
  generateTenantCredentials,
  hashTenantAccessKey,
} from "../../netlify/functions/_tenant-auth.mjs";
import { createTenantStore } from "../../netlify/functions/_tenant-store.mjs";
import { createTenantSignupHandler } from "../../netlify/functions/tenant-signup.mjs";

const URL = "https://preview.example/.netlify/functions/tenant-signup";

function signupRequest(body, { method = "POST", raw } = {}) {
  return new Request(URL, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : (raw ?? JSON.stringify(body)),
  });
}

function memoryStore() {
  const tenants = new Map();
  return {
    tenants,
    async createTenant(input) {
      assert.equal(Object.hasOwn(input, "tenantKey"), false);
      assert.equal(Object.hasOwn(input, "rawKey"), false);
      const row = {
        business_id: input.businessId,
        business_name: input.businessName,
        contact_name: input.contactName,
        contact_email: input.email,
        access_key_hash: input.accessKeyHash,
      };
      tenants.set(row.business_id, row);
      return structuredClone(row);
    },
    async readTenantAuth({ businessId }) {
      return structuredClone(tenants.get(businessId) ?? null);
    },
  };
}

test("tenant credentials use unique business IDs and 256-bit random access keys", () => {
  const first = generateTenantCredentials({ businessName: "Acme Hats" });
  const second = generateTenantCredentials({ businessName: "Acme Hats" });

  assert.match(first.businessId, /^acme-hats-[a-f0-9]{12}$/);
  assert.match(first.tenantKey, /^gw_tenant_[A-Za-z0-9_-]{43}$/);
  assert.match(first.accessKeyHash, /^[a-f0-9]{64}$/);
  assert.notEqual(first.businessId, second.businessId);
  assert.notEqual(first.tenantKey, second.tenantKey);
  assert.notEqual(first.accessKeyHash, second.accessKeyHash);
  assert.equal(first.accessKeyHash, hashTenantAccessKey(first.tenantKey));
});

test("signup stores only the key hash and returns the raw key once", async () => {
  const store = memoryStore();
  const handler = createTenantSignupHandler({ store });
  const response = await handler(signupRequest({
    business_name: "North Star Books",
    contact_name: "Jamie Rivera",
    email: "jamie@example.com",
  }));

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.match(body.business_id, /^north-star-books-[a-f0-9]{12}$/);
  assert.match(body.tenant_key, /^gw_tenant_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.plan_key, "founding_monthly");
  assert.equal(body.status, "not_subscribed");
  assert.equal(body.access_granted, false);

  const stored = store.tenants.get(body.business_id);
  assert.equal(stored.business_name, "North Star Books");
  assert.equal(stored.contact_name, "Jamie Rivera");
  assert.equal(stored.contact_email, "jamie@example.com");
  assert.equal(stored.access_key_hash, hashTenantAccessKey(body.tenant_key));
  assert.equal(JSON.stringify(stored).includes(body.tenant_key), false);
});

test("signup requires only valid business, contact, and email fields", async () => {
  const store = memoryStore();
  const handler = createTenantSignupHandler({ store });
  const invalidBodies = [
    { business_name: "", contact_name: "Jamie", email: "jamie@example.com" },
    { business_name: "Books", contact_name: "", email: "jamie@example.com" },
    { business_name: "Books", contact_name: "Jamie", email: "not-an-email" },
    { business_name: "B".repeat(161), contact_name: "Jamie", email: "jamie@example.com" },
    { business_name: "Books", contact_name: "J".repeat(161), email: "jamie@example.com" },
    { business_name: "Books", contact_name: "Jamie", email: `${"a".repeat(245)}@example.com` },
  ];

  for (const body of invalidBodies) {
    const response = await handler(signupRequest(body));
    assert.equal(response.status, 400);
  }
  assert.equal(store.tenants.size, 0);
});

test("signup rejects malformed, oversized, and non-POST requests", async () => {
  const store = memoryStore();
  const handler = createTenantSignupHandler({ store });

  assert.equal((await handler(signupRequest({}, { raw: "{" }))).status, 400);
  assert.equal((await handler(signupRequest({
    business_name: "Books", contact_name: "Jamie", email: "jamie@example.com", padding: "x".repeat(20_000),
  }))).status, 413);
  assert.equal((await handler(signupRequest({}, { method: "GET" }))).status, 405);
  assert.equal(store.tenants.size, 0);
});

test("tenant authorization requires the exact key for the exact business ID", async () => {
  const store = memoryStore();
  const credentials = generateTenantCredentials({ businessName: "Tenant One" });
  await store.createTenant({
    businessId: credentials.businessId,
    accessKeyHash: credentials.accessKeyHash,
    businessName: "Tenant One",
    contactName: "Taylor",
    email: "taylor@example.com",
  });

  const ownRequest = new Request("https://preview.example/status", {
    headers: { "x-growthwise-tenant-key": credentials.tenantKey },
  });
  const own = await authorizeTenantRequest(ownRequest, { businessId: credentials.businessId, store });
  assert.deepEqual(own, { ok: true, via: "tenant", businessId: credentials.businessId });

  const wrongBusiness = await authorizeTenantRequest(ownRequest, { businessId: "another-tenant-abcdef123456", store });
  assert.deepEqual(wrongBusiness, { ok: false, via: "none", businessId: null });

  const wrongKey = await authorizeTenantRequest(new Request("https://preview.example/status", {
    headers: { "x-growthwise-tenant-key": generateTenantCredentials({ businessName: "Other" }).tenantKey },
  }), { businessId: credentials.businessId, store });
  assert.deepEqual(wrongKey, { ok: false, via: "none", businessId: null });

  const emailOnly = await authorizeTenantRequest(new Request("https://preview.example/status", {
    headers: { "x-growthwise-email": "taylor@example.com" },
  }), { businessId: credentials.businessId, store });
  assert.equal(emailOnly.ok, false);
});

test("tenant store persists the hash and never sends a raw key to SQL", async () => {
  const calls = [];
  const pool = {
    async query(text, values) {
      calls.push({ text, values });
      if (text.includes("INSERT INTO growthwise_tenants")) {
        return { rows: [{
          business_id: values[0], business_name: values[1], contact_name: values[2],
          contact_email: values[3], access_key_hash: values[4],
        }] };
      }
      if (text.includes("FROM growthwise_tenants")) {
        return { rows: [{ business_id: values[0], access_key_hash: "f".repeat(64) }] };
      }
      throw new Error("Unexpected SQL");
    },
  };
  const store = createTenantStore({ getPool: async () => pool });
  const tenantKey = `gw_tenant_${"A".repeat(43)}`;
  const accessKeyHash = hashTenantAccessKey(tenantKey);

  await store.createTenant({
    businessId: "tenant-one-abcdef123456",
    businessName: "Tenant One",
    contactName: "Taylor",
    email: "taylor@example.com",
    accessKeyHash,
  });
  await store.readTenantAuth({ businessId: "tenant-one-abcdef123456" });

  assert.equal(calls[0].values[4], accessKeyHash);
  assert.equal(calls.some((call) => JSON.stringify(call.values).includes(tenantKey)), false);
});
