import assert from "node:assert/strict";
import test from "node:test";

import { sessionTokenPattern } from "../../netlify/functions/_connector-auth.mjs";
import { createTenantConnectorSessionStartHandler } from "../../netlify/functions/tenant-connector-session-start.mjs";

const ORIGIN = "https://deploy-preview-17--growthwise.example";
const BUSINESS_ID = "north-star-books-abcdef123456";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;
const NOW = new Date("2026-09-25T22:30:00.000Z");

function request(body = { business_id: BUSINESS_ID }, options = {}) {
  return new Request(`${ORIGIN}/.netlify/functions/tenant-connector-session-start`, {
    method: options.method || "POST",
    headers: {
      origin: options.origin || ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-growthwise-tenant-key": options.tenantKey || TENANT_KEY,
    },
    body: options.method === "GET" ? undefined : JSON.stringify(body),
  });
}

function fixture({
  authorized = true,
  planKey = "growth_monthly",
  status = "active",
  accessSource = "stripe",
} = {}) {
  const creates = [];
  const handler = createTenantConnectorSessionStartHandler({
    publicOrigin: () => ORIGIN,
    now: () => NOW,
    tenantStore: {},
    authorize: async (_request, { businessId }) => ({
      ok: authorized && businessId === BUSINESS_ID,
      businessId: authorized ? BUSINESS_ID : null,
      via: authorized ? "tenant" : "none",
    }),
    billingStore: {
      readSubscription: async () => ({
        business_id: BUSINESS_ID,
        plan_key: planKey,
        status,
        access_source: accessSource,
        plan_started_at: NOW,
      }),
    },
    connectorStore: {
      async createSession(input) {
        creates.push(input);
        return {
          business_id: input.businessId,
          connectors: input.connectors,
          expires_at: input.expiresAt,
        };
      },
    },
  });
  return { handler, creates };
}

test("eligible tenant creates its own short-lived connector session without an invitation", async () => {
  const { handler, creates } = fixture();
  const response = await handler(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    connection_url: "/connect-accounts.html",
    expires_at: "2026-09-25T23:00:00.000Z",
  });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].businessId, BUSINESS_ID);
  assert.deepEqual(creates[0].connectors, ["email", "instagram"]);
  assert.match(creates[0].sessionHash, /^[a-f0-9]{64}$/);
  assert.equal(creates[0].expiresAt.toISOString(), "2026-09-25T23:00:00.000Z");

  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, /^__Host-gw_connector_session=gw_conn_[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /Max-Age=1800/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes("Domain="), false);

  const raw = cookie.match(/__Host-gw_connector_session=([^;]+)/)?.[1] || "";
  assert.match(raw, sessionTokenPattern);
  assert.equal(JSON.stringify(body).includes(raw), false);
  assert.equal(body.connection_url.includes("gw_conn_"), false);
  assert.equal(body.connection_url.includes("gw_tenant_"), false);
});

test("Starter and inactive tenants cannot create connector sessions", async () => {
  for (const settings of [
    { planKey: "starter_monthly", status: "active" },
    { planKey: "growth_monthly", status: "past_due" },
  ]) {
    const { handler, creates } = fixture(settings);
    const response = await handler(request());
    assert.equal(response.status, 403);
    assert.equal(creates.length, 0);
  }
});

test("tenant connector session rejects cross-tenant auth and cross-origin requests", async () => {
  const unauthorized = fixture({ authorized: false });
  assert.equal((await unauthorized.handler(request())).status, 401);
  assert.equal(unauthorized.creates.length, 0);

  const wrongOrigin = fixture();
  const response = await wrongOrigin.handler(request(undefined, {
    origin: "https://evil.example",
  }));
  assert.equal(response.status, 403);
  assert.equal(wrongOrigin.creates.length, 0);
});
