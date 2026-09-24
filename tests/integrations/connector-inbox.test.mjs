import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createConnectorInboxHandler } from "../../netlify/functions/connector-inbox.mjs";
import { createConnectorInboxController } from "../../assets/connector-invitation.mjs";

const ORIGIN = "https://deploy-preview-14--growthwise.example";
const COOKIE = `__Host-gw_connector_session=gw_conn_${"A".repeat(43)}`;
const NOW = new Date("2026-09-24T14:00:00.000Z");

function request(path = "/.netlify/functions/connector-inbox", { cookie = COOKIE } = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
}

function authorizedStore({ businessId = "growthwise-dev", connectors = ["email"] } = {}) {
  return {
    async authorizeSession() {
      return {
        business_id: businessId,
        connectors,
        expires_at: new Date("2026-09-24T14:30:00.000Z"),
      };
    },
  };
}

test("connector inbox derives tenant from secure session and returns only allowed connector sources", async () => {
  const seen = [];
  const handler = createConnectorInboxHandler({
    store: authorizedStore(),
    now: () => NOW,
    listTenantLeads: async ({ businessId }) => {
      seen.push(businessId);
      return [
        {
          id: "email-1",
          business_id: "growthwise-dev",
          source: "Email",
          source_type: "email",
          source_account: "narleobit.test@outlook.com",
          customer_contact: "engineerbit57@gmail.com",
          message: "Subject: GrowthWise Microsoft Inbox Test\n\nHello GrowthWise.",
          direction: "inbound",
          received_at: "2026-09-24T13:31:27.000Z",
          unread: true,
          reply_supported: false,
          reply_target: "engineerbit57@gmail.com",
          status: "new",
          created_at: "2026-09-24T13:31:27.449Z",
        },
        {
          id: "instagram-1",
          business_id: "growthwise-dev",
          source: "Instagram",
          source_type: "instagram",
          message: "Not allowed by this email-only session",
          created_at: "2026-09-24T13:30:00.000Z",
        },
        {
          id: "wrong-tenant",
          business_id: "dexters-hats",
          source: "Email",
          source_type: "email",
          message: "Must never be returned",
          created_at: "2026-09-24T13:29:00.000Z",
        },
      ];
    },
  });

  const response = await handler(request());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(seen, ["growthwise-dev"]);
  assert.equal(body.business_id, "growthwise-dev");
  assert.deepEqual(body.sources, ["email"]);
  assert.equal(body.count, 1);
  assert.equal(body.leads.length, 1);
  assert.equal(body.leads[0].id, "email-1");
  assert.equal(body.leads[0].customer_contact, "engineerbit57@gmail.com");
  assert.equal(body.leads[0].reply_supported, false);
  assert.equal(JSON.stringify(body).includes("dexters-hats"), false);
  assert.equal(JSON.stringify(body).includes("instagram-1"), false);
});

test("connector inbox rejects browser-supplied tenant selectors", async () => {
  let queried = false;
  const handler = createConnectorInboxHandler({
    store: authorizedStore(),
    now: () => NOW,
    listTenantLeads: async () => {
      queried = true;
      return [];
    },
  });

  const response = await handler(request("/.netlify/functions/connector-inbox?business_id=dexters-hats"));
  assert.equal(response.status, 400);
  assert.equal(queried, false);
});

test("connector inbox requires the secure connector session cookie", async () => {
  const handler = createConnectorInboxHandler({
    store: authorizedStore(),
    now: () => NOW,
    listTenantLeads: async () => [],
  });

  const response = await handler(request("/.netlify/functions/connector-inbox", { cookie: "" }));
  assert.equal(response.status, 401);
});

test("connector inbox UI calls the session-bound endpoint without a business id", async () => {
  const calls = [];
  const states = [];
  const controller = createConnectorInboxController({
    onChange: (state) => states.push(state),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        business_id: "growthwise-dev",
        sources: ["email"],
        leads: [{
          id: "email-1",
          source: "Email",
          source_type: "email",
          customer_contact: "engineerbit57@gmail.com",
          message: "Subject: GrowthWise Microsoft Inbox Test",
          received_at: "2026-09-24T13:31:27.000Z",
          reply_supported: false,
          status: "new",
        }],
        count: 1,
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  const state = await controller.load();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/connector-inbox");
  assert.equal(calls[0].url.includes("business_id"), false);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.equal(state.businessId, "growthwise-dev");
  assert.equal(state.leads.length, 1);
  assert.equal(states.at(-1).leads[0].source_type, "email");
});

test("secure connector page includes a read-only tenant-bound inbox surface", async () => {
  const html = await readFile(new URL("../../connect-accounts.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../../assets/connector-invitation.mjs", import.meta.url), "utf8");

  assert.match(html, /Recent inbound messages/);
  assert.match(html, /browser cannot choose or override the tenant/);
  assert.match(html, /id="connector-inbox-list"/);
  assert.match(js, /\/connector-inbox/);
  assert.match(js, /mountConnectorInbox/);
  assert.doesNotMatch(js, /connector-inbox\?business_id=/);
});
