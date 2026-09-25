import assert from "node:assert/strict";
import test from "node:test";

import { createTenantProfileHandler } from "../../netlify/functions/tenant-profile.mjs";
import { hashTenantAccessKey } from "../../netlify/functions/_tenant-auth.mjs";

const BUSINESS_ID = "north-star-books-abcdef123456";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;
const URL = "https://preview.example/.netlify/functions/tenant-profile";

function request(businessId = BUSINESS_ID, key = TENANT_KEY) {
  return new Request(`${URL}?business_id=${encodeURIComponent(businessId)}`, {
    headers: key ? { "x-growthwise-tenant-key": key } : {},
  });
}

function store() {
  return {
    async readTenantAuth({ businessId }) {
      return businessId === BUSINESS_ID
        ? { business_id: businessId, access_key_hash: hashTenantAccessKey(TENANT_KEY) }
        : null;
    },
    async readTenantProfile({ businessId }) {
      return businessId === BUSINESS_ID ? {
        business_id: BUSINESS_ID,
        business_name: "North Star Books",
        contact_name: "Jamie Rivera",
        contact_email: "jamie@example.com",
        access_key_hash: "must-not-leak",
        created_at: new Date("2026-09-24T12:00:00.000Z"),
      } : null;
    },
  };
}

test("tenant profile requires exact tenant credentials", async () => {
  const handler = createTenantProfileHandler({ store: store() });
  assert.equal((await handler(request(BUSINESS_ID, "wrong"))).status, 401);
  assert.equal((await handler(request("another-business-abcdef123456"))).status, 401);
});

test("tenant profile returns only safe authenticated profile fields", async () => {
  const handler = createTenantProfileHandler({ store: store() });
  const response = await handler(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    business_id: BUSINESS_ID,
    business_name: "North Star Books",
    contact_name: "Jamie Rivera",
    contact_email: "jamie@example.com",
    created_at: "2026-09-24T12:00:00.000Z",
  });
  assert.equal(JSON.stringify(body).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(body).includes(TENANT_KEY), false);
});

test("tenant profile rejects extra or duplicate tenant selectors", async () => {
  const handler = createTenantProfileHandler({ store: store() });
  for (const url of [
    `${URL}?business_id=${BUSINESS_ID}&other=dexters-hats`,
    `${URL}?business_id=${BUSINESS_ID}&business_id=dexters-hats`,
  ]) {
    const response = await handler(new Request(url, {
      headers: { "x-growthwise-tenant-key": TENANT_KEY },
    }));
    assert.equal(response.status, 400);
  }
});

test("tenant profile allows only GET", async () => {
  const handler = createTenantProfileHandler({ store: store() });
  const response = await handler(new Request(URL, { method: "POST" }));
  assert.equal(response.status, 405);
});
