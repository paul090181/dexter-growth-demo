import assert from "node:assert/strict";
import test from "node:test";

import { createTenantInboxActionHandler } from "../../netlify/functions/tenant-inbox-action.mjs";

const ORIGIN = "https://preview.example";
const BUSINESS_ID = "north-star-books-abcdef123456";
const OTHER_ID = "other-business-abcdef123456";
const NOW = new Date("2026-09-27T18:00:00.000Z");

function request(body) {
  return new Request(ORIGIN + "/.netlify/functions/tenant-inbox-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function growthSubscription() {
  return {
    business_id: BUSINESS_ID,
    access_source: "stripe",
    plan_key: "growth_monthly",
    status: "active",
  };
}

test("tenant inbox mark-read updates only a message belonging to the authorized business", async () => {
  const calls = [];
  const handler = createTenantInboxActionHandler({
    tenantStore: {},
    billingStore: {
      async readSubscription({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return growthSubscription();
      },
    },
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    markRead: async ({ businessId, leadId }) => {
      calls.push({ businessId, leadId });
      return { id: leadId, business_id: businessId, unread: false, status: "new" };
    },
    now: () => NOW,
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    lead_id: "ig-message-1",
    action: "mark_read",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    business_id: BUSINESS_ID,
    lead_id: "ig-message-1",
    unread: false,
    status: "new",
  });
  assert.deepEqual(calls, [{ businessId: BUSINESS_ID, leadId: "ig-message-1" }]);
});

test("tenant inbox workflow actions set follow-up, close, and reopen safely", async () => {
  const calls = [];
  const handler = createTenantInboxActionHandler({
    tenantStore: {},
    billingStore: { readSubscription: async () => growthSubscription() },
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    setStatus: async ({ businessId, leadId, status }) => {
      calls.push({ businessId, leadId, status });
      return { id: leadId, business_id: businessId, unread: false, status };
    },
    now: () => NOW,
  });

  for (const [action, expectedStatus] of [
    ["needs_follow_up", "follow-up"],
    ["close", "closed"],
    ["reopen", "new"],
  ]) {
    const response = await handler(request({
      business_id: BUSINESS_ID,
      lead_id: "ig-message-1",
      action,
    }));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, expectedStatus);
    assert.equal(body.unread, false);
  }

  assert.deepEqual(calls.map((call) => call.status), ["follow-up", "closed", "new"]);
  assert.equal(calls.every((call) => call.businessId === BUSINESS_ID), true);
});

test("tenant inbox mark-read blocks cross-tenant authorization before any update", async () => {
  let billingReads = 0;
  let updates = 0;
  const handler = createTenantInboxActionHandler({
    tenantStore: {},
    billingStore: {
      async readSubscription() {
        billingReads += 1;
        return growthSubscription();
      },
    },
    authorize: async () => ({ ok: true, businessId: OTHER_ID }),
    markRead: async () => {
      updates += 1;
      return null;
    },
    setStatus: async () => {
      updates += 1;
      return null;
    },
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    lead_id: "ig-message-1",
    action: "mark_read",
  }));
  assert.equal(response.status, 401);
  assert.equal(billingReads, 0);
  assert.equal(updates, 0);
});

test("tenant inbox mark-read fails closed when the lead is not in this tenant", async () => {
  const handler = createTenantInboxActionHandler({
    tenantStore: {},
    billingStore: { readSubscription: async () => growthSubscription() },
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    markRead: async () => null,
    now: () => NOW,
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    lead_id: "not-owned",
    action: "mark_read",
  }));
  assert.equal(response.status, 404);
});

test("tenant inbox mark-read accepts no arbitrary mutation actions", async () => {
  let updates = 0;
  const handler = createTenantInboxActionHandler({
    tenantStore: {},
    billingStore: {},
    authorize: async () => ({ ok: true, businessId: BUSINESS_ID }),
    markRead: async () => {
      updates += 1;
      return null;
    },
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    lead_id: "message-1",
    action: "delete",
  }));
  assert.equal(response.status, 400);
  assert.equal(updates, 0);
});
