import assert from "node:assert/strict";
import test from "node:test";

import { hashOpaqueToken } from "../../netlify/functions/_connector-auth.mjs";
import { createInstagramConnectionHandler } from "../../netlify/functions/instagram-connection.mjs";
import { createInstagramOAuthStartHandler } from "../../netlify/functions/instagram-oauth-start.mjs";
import { INSTAGRAM_AUTHORIZATION_SCOPE } from "../../netlify/functions/_instagram-oauth.mjs";
import { resolveInstagramReturnDestination } from "../../netlify/functions/_instagram-clients.mjs";

const ORIGIN = "https://growthwise.example";
const SESSION = `gw_conn_${"A".repeat(43)}`;
const NOW = new Date("2026-09-23T12:00:00.000Z");
const clients = {
  "dexters-hats": {
    business_id: "dexters-hats",
    returnDestinationId: "dexter-integration",
    authorizationScope: INSTAGRAM_AUTHORIZATION_SCOPE,
    integrations: { instagram: { review_publish_enabled: true, messages_enabled: true } },
  },
  "growthwise-dev": {
    business_id: "growthwise-dev",
    returnDestinationId: "growthwise-dev-integration",
    authorizationScope: "instagram_business_basic",
    integrations: { instagram: {} },
  },
};

function connectorStore({ businessId = "dexters-hats", connectors = ["instagram"] } = {}) {
  return {
    async authorizeSession({ sessionHash, businessId: requested, connector, now }) {
      assert.equal(sessionHash, hashOpaqueToken(SESSION));
      if (requested && requested !== businessId) throw new Error("SESSION_INVALID");
      if (connector && !connectors.includes(connector)) throw new Error("SESSION_INVALID");
      return { business_id: businessId, connectors, expires_at: new Date(now.getTime() + 10_000) };
    },
  };
}

function request(path, { businessId = "dexters-hats", cookie = SESSION, adminKey, method } = {}) {
  const isStart = path === "instagram-oauth-start";
  const headers = {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    ...(cookie ? { cookie: `__Host-gw_connector_session=${cookie}` } : {}),
    ...(adminKey ? { "x-growthwise-key": adminKey } : {}),
  };
  if (isStart) headers["content-type"] = "application/json";
  return new Request(`${ORIGIN}/.netlify/functions/${path}${isStart ? "" : `?business_id=${businessId}`}`, {
    method: method ?? (isStart ? "POST" : "GET"), headers,
    body: isStart ? JSON.stringify({ business_id: businessId }) : undefined,
  });
}

function startFixture({ store = connectorStore(), adminKey = () => "admin" } = {}) {
  const creates = [];
  const handler = createInstagramOAuthStartHandler({
    adminKey,
    connectorStore: store,
    publicOrigin: () => ORIGIN,
    appId: () => "app",
    now: () => NOW,
    rateLimiter: { consume: async () => true },
    getClient: (id) => {
      if (!clients[id]) throw new Error("not found");
      return clients[id];
    },
    crypto: { createState: () => ({ state: "v1.synthetic.tag", nonceHash: "hash" }) },
    store: { async createTransactionWithFreshState({ createState, ...record }) {
      creates.push(record); return { state: createState().state };
    } },
    buildUrl: ({ appId, callbackUri, state, scope }) => `https://www.instagram.com/oauth/authorize?client_id=${appId}&redirect_uri=${encodeURIComponent(callbackUri)}&response_type=code&scope=${encodeURIComponent(scope)}&state=${state}`,
  });
  return { handler, creates };
}

test("Dexter connector session starts Instagram for only Dexter and uses the fixed customer return", async () => {
  const fixture = startFixture();
  const response = await fixture.handler(request("instagram-oauth-start"));
  assert.equal(response.status, 200);
  assert.equal(fixture.creates.length, 1);
  assert.equal(fixture.creates[0].businessId, "dexters-hats");
  assert.equal(fixture.creates[0].returnDestinationId, "connector-customer-integration");
});

test("connector session cannot start Instagram for a different tenant or without Instagram scope", async () => {
  const wrongTenant = startFixture();
  assert.equal((await wrongTenant.handler(request("instagram-oauth-start", { businessId: "growthwise-dev" }))).status, 401);
  assert.equal(wrongTenant.creates.length, 0);

  const wrongScope = startFixture({ store: connectorStore({ connectors: ["facebook"] }) });
  assert.equal((await wrongScope.handler(request("instagram-oauth-start"))).status, 401);
  assert.equal(wrongScope.creates.length, 0);
});

test("connector session reads Instagram health only for its stored tenant", async () => {
  const handler = createInstagramConnectionHandler({
    adminKey: () => "admin",
    connectorStore: connectorStore(),
    clients,
    now: () => NOW,
    readCredential: async () => null,
    env: () => undefined,
    logger: { warn() {} },
  });
  const good = await handler(request("instagram-connection"));
  assert.equal(good.status, 200);
  assert.equal((await good.json()).business_id, "dexters-hats");
  assert.equal((await handler(request("instagram-connection", { businessId: "growthwise-dev" }))).status, 401);
});

test("existing admin Instagram start and health paths remain functional", async () => {
  const start = startFixture();
  const startResponse = await start.handler(request("instagram-oauth-start", { cookie: "", adminKey: "admin" }));
  assert.equal(startResponse.status, 200);
  assert.equal(start.creates[0].returnDestinationId, "dexter-integration");

  const health = createInstagramConnectionHandler({
    adminKey: () => "admin", clients, now: () => NOW, readCredential: async () => null,
    env: () => undefined, logger: { warn() {} },
  });
  assert.equal((await health(request("instagram-connection", { cookie: "", adminKey: "admin" }))).status, 200);
});

test("customer return destination is fixed and rejects unsafe hints or origins", () => {
  assert.equal(resolveInstagramReturnDestination({
    destinationId: "connector-customer-integration", hint: "connected", publicOrigin: ORIGIN,
  }), `${ORIGIN}/connect-accounts.html?instagram=connected`);
  assert.throws(() => resolveInstagramReturnDestination({
    destinationId: "connector-customer-integration", hint: "https://evil.example", publicOrigin: ORIGIN,
  }), /hint/i);
});

test("database-backed connector session receives identity-only Instagram health and start", async () => {
  const paidStore = connectorStore({ businessId: "paid-shop-abcdef123456" });
  const start = startFixture({ store: paidStore });
  const startResponse = await start.handler(request("instagram-oauth-start", { businessId: "paid-shop-abcdef123456" }));
  assert.equal(startResponse.status, 200);
  assert.equal(start.creates[0].businessId, "paid-shop-abcdef123456");
  assert.equal(start.creates[0].returnDestinationId, "connector-customer-integration");

  const health = createInstagramConnectionHandler({
    adminKey: () => "admin", connectorStore: paidStore, clients, now: () => NOW,
    readCredential: async () => null, env: () => undefined, logger: { warn() {} },
  });
  const healthResponse = await health(request("instagram-connection", { businessId: "paid-shop-abcdef123456" }));
  assert.equal(healthResponse.status, 200);
  assert.equal((await healthResponse.json()).state, "Not Connected");
});
