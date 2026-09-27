import assert from "node:assert/strict";
import test from "node:test";

import { createTenantInboxHandler } from "../../netlify/functions/tenant-inbox.mjs";

const ORIGIN = "https://preview.example";
const BUSINESS_ID = "north-star-books-abcdef123456";
const OTHER_ID = "other-business-abcdef123456";
const NOW = new Date("2026-09-27T17:30:00.000Z");

function request(id = BUSINESS_ID) {
  return new Request(
    ORIGIN + "/.netlify/functions/tenant-inbox?business_id=" + encodeURIComponent(id),
    { method: "GET" },
  );
}

function activeGrowthSubscription() {
  return {
    business_id: BUSINESS_ID,
    access_source: "stripe",
    plan_key: "growth_monthly",
    status: "active",
  };
}

test("tenant inbox returns only rows for the authorized business and supported sources", async () => {
  const queried = [];
  const handler = createTenantInboxHandler({
    tenantStore: {},
    billingStore: {
      async readSubscription({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return activeGrowthSubscription();
      },
    },
    authorize: async (_request, { businessId }) => ({
      ok: businessId === BUSINESS_ID,
      businessId: businessId === BUSINESS_ID ? BUSINESS_ID : null,
    }),
    listTenantLeads: async ({ businessId }) => {
      queried.push(businessId);
      return [
        {
          id: "ig-1",
          business_id: BUSINESS_ID,
          source: "Instagram",
          source_type: "instagram",
          customer_name: "Customer One",
          customer_contact: "@customer",
          message: "Do you have this in another size?",
          direction: "inbound",
          unread: true,
          reply_supported: true,
          status: "new",
          created_at: NOW,
        },
        {
          id: "fb-1",
          business_id: BUSINESS_ID,
          source: "Facebook",
          source_type: "facebook",
          message: "Can I pick this up Saturday?",
          direction: "inbound",
          unread: false,
          reply_supported: false,
          status: "new",
          created_at: NOW,
        },
        {
          id: "wrong-tenant",
          business_id: OTHER_ID,
          source: "Instagram",
          source_type: "instagram",
          message: "Never return this",
          created_at: NOW,
        },
        {
          id: "unsupported",
          business_id: BUSINESS_ID,
          source: "Unknown",
          source_type: "unknown",
          message: "Never return this either",
          created_at: NOW,
        },
      ];
    },
    now: () => NOW,
  });

  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(queried, [BUSINESS_ID]);
  assert.equal(body.ok, true);
  assert.equal(body.business_id, BUSINESS_ID);
  assert.equal(body.count, 2);
  assert.equal(body.unread_count, 1);
  assert.deepEqual(body.leads.map((lead) => lead.id), ["ig-1", "fb-1"]);
  assert.equal(JSON.stringify(body).includes("wrong-tenant"), false);
  assert.equal(JSON.stringify(body).includes("unsupported"), false);
});

test("tenant inbox blocks another tenant before reading subscriptions or messages", async () => {
  let billingReads = 0;
  let leadReads = 0;
  const handler = createTenantInboxHandler({
    tenantStore: {},
    billingStore: {
      async readSubscription() {
        billingReads += 1;
        return activeGrowthSubscription();
      },
    },
    authorize: async () => ({ ok: false, businessId: null }),
    listTenantLeads: async () => {
      leadReads += 1;
      return [];
    },
  });

  const response = await handler(request(OTHER_ID));
  assert.equal(response.status, 401);
  assert.equal(billingReads, 0);
  assert.equal(leadReads, 0);
});

test("tenant inbox respects the unified-inbox plan entitlement", async () => {
  let leadReads = 0;
  const handler = createTenantInboxHandler({
    tenantStore: {},
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
        };
      },
    },
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    listTenantLeads: async () => {
      leadReads += 1;
      return [];
    },
    now: () => NOW,
  });

  const response = await handler(request());
  assert.equal(response.status, 403);
  assert.equal(leadReads, 0);
});

test("tenant inbox rejects extra tenant selectors and never accepts arbitrary filters", async () => {
  let leadReads = 0;
  const handler = createTenantInboxHandler({
    tenantStore: {},
    billingStore: {},
    authorize: async () => ({ ok: true, businessId: BUSINESS_ID }),
    listTenantLeads: async () => {
      leadReads += 1;
      return [];
    },
  });

  const response = await handler(new Request(
    ORIGIN + "/.netlify/functions/tenant-inbox?business_id=" + BUSINESS_ID + "&source=facebook",
  ));
  assert.equal(response.status, 400);
  assert.equal(leadReads, 0);
});
