import assert from "node:assert/strict";
import test from "node:test";

import { authorizeRetailLeadRequest } from "../../netlify/functions/retail-lead-assistant.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";

const BUSINESS_ID = "north-star-books-abcdef123456";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

function request(headers = {}) {
  return new Request("https://preview.example/.netlify/functions/retail-lead-assistant", { headers });
}

function tenantStore() {
  return {
    async readTenantAuth({ businessId }) {
      return businessId === BUSINESS_ID
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null;
    },
    async readTenantProfile({ businessId }) {
      return businessId === BUSINESS_ID
        ? { business_id: businessId, business_name: "North Star Books" }
        : null;
    },
  };
}


function billingStore(status = "active") {
  return {
    async readSubscription({ businessId }) {
      return businessId === BUSINESS_ID
        ? { business_id: businessId, access_source: "stripe", plan_key: "founding_monthly", status }
        : null;
    },
  };
}

test("retail lead assistant accepts the exact tenant key for the exact business", async () => {
  const result = await authorizeRetailLeadRequest(
    request({ "x-growthwise-tenant-key": TENANT_KEY }),
    { businessId: BUSINESS_ID, tenantStore: tenantStore(), billingStore: billingStore() },
  );

  assert.equal(result.ok, true);
  assert.equal(result.via, "tenant");
  assert.equal(result.businessId, BUSINESS_ID);
  assert.equal(result.profile.business_name, "North Star Books");
});

test("retail lead assistant rejects a tenant key for another business", async () => {
  const result = await authorizeRetailLeadRequest(
    request({ "x-growthwise-tenant-key": TENANT_KEY }),
    { businessId: "another-business-abcdef123456", tenantStore: tenantStore(), billingStore: billingStore() },
  );

  assert.deepEqual(result, { ok: false, via: "none", businessId: null, profile: null });
});



test("retail lead assistant rejects valid tenant credentials when paid access is inactive", async () => {
  for (const status of ["past_due", "unpaid", "canceled", "incomplete"]) {
    const result = await authorizeRetailLeadRequest(
      request({ "x-growthwise-tenant-key": TENANT_KEY }),
      {
        businessId: BUSINESS_ID,
        tenantStore: tenantStore(),
        billingStore: billingStore(status),
      },
    );
    assert.deepEqual(result, { ok: false, via: "locked", businessId: null, profile: null });
  }
});

test("retail lead assistant preserves operator/admin access for the Dexter pilot", async () => {
  const result = await authorizeRetailLeadRequest(
    request({ "x-growthwise-key": "admin-test" }),
    { businessId: "dexters-hats", adminKey: "admin-test", tenantStore: tenantStore() },
  );

  assert.deepEqual(result, { ok: true, via: "admin", businessId: "dexters-hats", profile: null });
});

test("retail lead assistant does not accept arbitrary headers as tenant auth", async () => {
  const result = await authorizeRetailLeadRequest(
    request({ "x-growthwise-key": "wrong", "x-growthwise-tenant-key": "wrong" }),
    { businessId: BUSINESS_ID, adminKey: "admin-test", tenantStore: tenantStore(), billingStore: billingStore("canceled") },
  );

  assert.equal(result.ok, false);
});
