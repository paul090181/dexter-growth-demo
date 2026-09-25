import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  clearWorkspaceCredentials,
  createTenantWorkspaceController,
  readWorkspaceCredentials,
  saveWorkspaceCredentials,
} from "../../assets/tenant-workspace.mjs";

const BUSINESS_ID = "north-star-books-abcdef123456";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

function storage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("workspace credentials stay in session storage only", () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  clearWorkspaceCredentials(s);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: "", tenantKey: "" });
});

test("workspace sign-in validates tenant profile and subscription before persisting", async () => {
  const s = storage();
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          contact_name: "Jamie",
          contact_email: "jamie@example.com",
        });
      }
      return response({
        business_id: BUSINESS_ID,
        access_source: "stripe",
        plan_key: "founding_monthly",
        status: "active",
        access_granted: true,
      });
    },
  });

  const state = await controller.authenticate({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  assert.equal(state.signedIn, true);
  assert.equal(state.profile.business_name, "North Star Books");
  assert.equal(state.subscription.access_granted, true);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("failed sign-in clears attempted workspace credentials", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async () => response({ error: "Unauthorized" }, 401),
  });
  const state = await controller.authenticate({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  assert.equal(state.signedIn, false);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: "", tenantKey: "" });
});

test("billing management uses server-linked Stripe portal only", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let navigated = "";
  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => { navigated = url; },
    fetchImpl: async (url, init) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) return response({
        business_id: BUSINESS_ID, business_name: "North Star Books",
      });
      if (url.startsWith("/.netlify/functions/subscription-status?")) return response({
        business_id: BUSINESS_ID, access_source: "stripe", status: "active", access_granted: true,
      });
      assert.equal(url, "/.netlify/functions/stripe-customer-portal");
      assert.deepEqual(JSON.parse(init.body), { business_id: BUSINESS_ID });
      return response({ portal_url: "https://billing.stripe.com/p/session/test_123" });
    },
  });

  await controller.restore();
  assert.equal(await controller.openBilling(), true);
  assert.equal(navigated, "https://billing.stripe.com/p/session/test_123");
});

test("tenant workspace is generic and does not expose Dexter/admin credentials", () => {
  const html = fs.readFileSync(new URL("../../app.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../../assets/tenant-workspace.mjs", import.meta.url), "utf8");
  const headers = fs.readFileSync(new URL("../../_headers", import.meta.url), "utf8");

  assert.match(html, /Business workspace/);
  assert.match(html, /Workspace ID/);
  assert.doesNotMatch(html + js, /dexters-hats|Dexter's Hats|growthwise_admin_key|X-GrowthWise-Key/);
  assert.doesNotMatch(html + js, /localStorage/);
  assert.match(headers, /\/app\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});
