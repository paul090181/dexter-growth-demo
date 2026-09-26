import assert from "node:assert/strict";
import test from "node:test";

import { createPilotAccessGrantHandler } from "../../netlify/functions/pilot-access-grant.mjs";

const BUSINESS_ID = "north-star-books-abcdef123456";
const ORIGIN = "https://deploy-preview-17--euphonious-beijinho-db4b4d.netlify.app";

function request(body = { business_id: BUSINESS_ID }) {
  return new Request(`${ORIGIN}/.netlify/functions/pilot-access-grant`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("pilot access grant is admin-only and preview-gated", async () => {
  let reads = 0;
  const handler = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: false }),
    isEnabled: () => true,
    tenantStore: { async readTenantProfile() { reads += 1; return {}; } },
    billingStore: { async grantPilotAccess() { throw new Error("should not run"); } },
  });
  const unauthorized = await handler(request());
  assert.equal(unauthorized.status, 401);
  assert.equal(reads, 0);

  const disabled = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: true }),
    isEnabled: () => false,
    tenantStore: { async readTenantProfile() { throw new Error("should not run"); } },
    billingStore: { async grantPilotAccess() { throw new Error("should not run"); } },
  });
  assert.equal((await disabled(request())).status, 404);
});

test("pilot access grant is unavailable outside the GrowthWise deploy-preview host", async () => {
  const handler = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: true }),
    tenantStore: { async readTenantProfile() { throw new Error("should not run"); } },
    billingStore: { async grantPilotAccess() { throw new Error("should not run"); } },
  });
  const response = await handler(new Request("https://growthwise.example/.netlify/functions/pilot-access-grant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ business_id: BUSINESS_ID }),
  }));
  assert.equal(response.status, 404);
});

test("pilot access is granted only to an existing workspace with the founding plan", async () => {
  let grantInput;
  const now = new Date("2026-09-26T04:30:00.000Z");
  const handler = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: true }),
    isEnabled: () => true,
    now: () => now,
    tenantStore: {
      async readTenantProfile({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return { business_id: BUSINESS_ID, business_name: "North Star Books" };
      },
    },
    billingStore: {
      async grantPilotAccess(input) {
        grantInput = input;
        return {
          business_id: BUSINESS_ID,
          access_source: "pilot",
          plan_key: "founding_monthly",
          status: "pilot",
          stripe_customer_id: null,
        };
      },
    },
  });

  const response = await handler(request());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(grantInput, {
    businessId: BUSINESS_ID,
    planKey: "founding_monthly",
    startedAt: now,
  });
  assert.deepEqual(body, {
    ok: true,
    business_id: BUSINESS_ID,
    access_source: "pilot",
    plan_key: "founding_monthly",
    status: "pilot",
  });
  assert.equal(JSON.stringify(body).includes("stripe_customer_id"), false);
});

test("unknown workspaces and Stripe-managed workspaces fail closed", async () => {
  let grants = 0;
  const unknown = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: true }),
    isEnabled: () => true,
    tenantStore: { async readTenantProfile() { return null; } },
    billingStore: { async grantPilotAccess() { grants += 1; } },
  });
  assert.equal((await unknown(request())).status, 404);
  assert.equal(grants, 0);

  const conflict = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: true }),
    isEnabled: () => true,
    tenantStore: { async readTenantProfile() { return { business_id: BUSINESS_ID }; } },
    billingStore: { async grantPilotAccess() { throw new Error("PILOT_ACCESS_NOT_GRANTED"); } },
  });
  const response = await conflict(request());
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /Stripe-managed billing/i);
});

test("pilot access grant accepts only the business_id field", async () => {
  const handler = createPilotAccessGrantHandler({
    isAuthorized: () => ({ ok: true }),
    isEnabled: () => true,
    tenantStore: { async readTenantProfile() { throw new Error("should not run"); } },
    billingStore: { async grantPilotAccess() { throw new Error("should not run"); } },
  });
  const response = await handler(request({ business_id: BUSINESS_ID, plan_key: "pro_monthly" }));
  assert.equal(response.status, 400);
});
