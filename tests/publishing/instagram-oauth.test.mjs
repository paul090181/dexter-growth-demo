import test from "node:test";
import assert from "node:assert/strict";
import { createInstagramOAuthStartHandler } from "../../netlify/functions/instagram-oauth-start.mjs";
import { createInstagramOAuthCallbackHandler } from "../../netlify/functions/instagram-oauth-callback.mjs";

const ORIGIN = "https://growthwise.example";
const ADMIN = "SENTINEL_ADMIN_KEY_DO_NOT_LEAK";

function makeRequest(body = { business_id: "growthwise-dev" }, options = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Headers({
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "x-growthwise-key": ADMIN,
    ...options.headers,
  });
  return new Request(options.url ?? `${ORIGIN}/.netlify/functions/instagram-oauth-start`, {
    method: options.method ?? "POST", headers, body: (options.method ?? "POST") === "POST" ? text : undefined,
  });
}

function fixture(overrides = {}) {
  const creates = [];
  let nonce = 0;
  const dependencies = {
    adminKey: () => ADMIN,
    publicOrigin: () => ORIGIN,
    appId: () => "synthetic-app-id",
    crypto: { createState: () => ({ state: `v1.synthetic-${++nonce}.tag`, nonceHash: `hash-${nonce}` }) },
    store: { createTransactionWithFreshState: async ({ createState, ...record }) => {
      const generated = createState(); creates.push({ ...record, transactionKey: generated.nonceHash });
      return { state: generated.state };
    } },
    getClient: (id) => {
      const destinations = { "growthwise-dev": "growthwise-dev-integration", "dexters-hats": "dexter-integration" };
      if (!destinations[id]) throw new Error("not found");
      return { business_id: id, returnDestinationId: destinations[id] };
    },
    buildUrl: ({ appId, callbackUri, state }) => `https://www.instagram.com/oauth/authorize?client_id=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(callbackUri)}&state=${encodeURIComponent(state)}&scope=instagram_business_basic&response_type=code`,
    now: () => new Date("2026-09-17T12:00:00.000Z"),
    rateLimiter: { consume: async () => true },
    ...overrides,
  };
  return { handler: createInstagramOAuthStartHandler(dependencies), creates };
}

test("OAuth start without configured server admin key fails before storage", async () => {
  let touched = false;
  const { handler } = fixture({ adminKey: () => "", store: { createTransactionWithFreshState: async () => { touched = true; } } });
  assert.equal((await handler(makeRequest())).status, 503);
  assert.equal(touched, false);
});

test("OAuth start with wrong admin key fails before storage", async () => {
  let touched = false;
  const { handler } = fixture({ store: { createTransactionWithFreshState: async () => { touched = true; } } });
  assert.equal((await handler(makeRequest(undefined, { headers: { "x-growthwise-key": "wrong" } }))).status, 401);
  assert.equal(touched, false);
});

test("OAuth start rejects unknown business and malformed business ID", async () => {
  for (const business_id of ["unknown", " growthwise-dev", "growthwise-dev/", 4, null]) {
    const { handler, creates } = fixture();
    assert.equal((await handler(makeRequest({ business_id }))).status, 400);
    assert.equal(creates.length, 0);
  }
});

test("OAuth start rejects cross-origin and non-canonical requests", async () => {
  for (const request of [
    makeRequest(undefined, { headers: { origin: "https://evil.example" } }),
    makeRequest(undefined, { headers: { "sec-fetch-site": "cross-site" } }),
    makeRequest(undefined, { url: "http://growthwise.example/.netlify/functions/instagram-oauth-start" }),
    makeRequest(undefined, { url: `${ORIGIN}/.netlify/functions/instagram-oauth-start?next=evil` }),
  ]) {
    const { handler, creates } = fixture();
    assert.equal((await handler(request)).status, 403);
    assert.equal(creates.length, 0);
  }
});

test("OAuth start rejects non-POST wrong content type extra body fields and oversized body", async () => {
  const requests = [
    makeRequest(undefined, { method: "GET" }),
    makeRequest(undefined, { headers: { "content-type": "text/plain" } }),
    makeRequest({ business_id: "growthwise-dev", return_url: "https://evil.example" }),
    makeRequest(`{"business_id":"growthwise-dev","padding":"${"x".repeat(1100)}"}`),
  ];
  for (const request of requests) {
    const { handler, creates } = fixture();
    assert.notEqual((await handler(request)).status, 200);
    assert.equal(creates.length, 0);
  }
});

test("OAuth start bounds streamed bodies without trusting content length and rejects invalid UTF-8", async () => {
  const encoder = new TextEncoder();
  for (const { chunks, contentLength } of [
    { chunks: [encoder.encode('{"business_id":"growthwise-dev","padding":"'), encoder.encode("x".repeat(1100)), encoder.encode('"}')], contentLength: undefined },
    { chunks: [encoder.encode('{"business_id":"growthwise-dev","padding":"'), encoder.encode("x".repeat(1100)), encoder.encode('"}')], contentLength: "20" },
    { chunks: [Uint8Array.of(0x7b, 0x22, 0xff, 0x22, 0x7d)], contentLength: undefined },
  ]) {
    const headers = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-growthwise-key": ADMIN };
    if (contentLength) headers["content-length"] = contentLength;
    const stream = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close(); } });
    const request = new Request(`${ORIGIN}/.netlify/functions/instagram-oauth-start`, { method: "POST", headers, body: stream, duplex: "half" });
    const { handler, creates } = fixture();
    assert.equal((await handler(request)).status, 400);
    assert.equal(creates.length, 0);
  }
});

test("valid start creates one ten-minute tenant-bound transaction", async () => {
  const { handler, creates } = fixture();
  assert.equal((await handler(makeRequest())).status, 200);
  assert.equal(creates.length, 1);
  assert.equal(creates[0].businessId, "growthwise-dev");
  assert.equal(creates[0].expiresAt.toISOString(), "2026-09-17T12:10:00.000Z");
});

test("growthwise-dev transaction receives growthwise-dev-integration destination", async () => {
  const { handler, creates } = fixture(); await handler(makeRequest());
  assert.equal(creates[0].returnDestinationId, "growthwise-dev-integration");
});

test("dexters-hats transaction receives dexter-integration destination", async () => {
  const { handler, creates } = fixture(); await handler(makeRequest({ business_id: "dexters-hats" }));
  assert.equal(creates[0].returnDestinationId, "dexter-integration");
});

test("valid start returns only one safe HTTPS Meta authorization URL", async () => {
  const { handler } = fixture(); const response = await handler(makeRequest()); const body = await response.json();
  assert.deepEqual(Object.keys(body), ["authorization_url"]);
  const url = new URL(body.authorization_url);
  assert.equal(url.origin, "https://www.instagram.com"); assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(response.headers.get("cache-control"), "no-store"); assert.equal(response.headers.get("pragma"), "no-cache");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer"); assert.equal(response.headers.has("access-control-allow-origin"), false);
});

test("OAuth start rejects authorization URL credentials fragments duplicate extra or overridden parameters", async () => {
  const base = "https://www.instagram.com/oauth/authorize?client_id=synthetic-app-id&redirect_uri=https%3A%2F%2Fgrowthwise.example%2F.netlify%2Ffunctions%2Finstagram-oauth-callback&response_type=code&scope=instagram_business_basic&state=v1.synthetic-1.tag";
  const unsafe = [
    base.replace("https://", "https://user:password@"),
    `${base}#fragment`, `${base}&extra=true`, `${base}&state=override`,
    base.replace("scope=instagram_business_basic", "scope=instagram_business_content_publish"),
    base.replace("redirect_uri=https%3A%2F%2Fgrowthwise.example%2F.netlify%2Ffunctions%2Finstagram-oauth-callback", "redirect_uri=https%3A%2F%2Fevil.example%2Fcallback"),
  ];
  for (const value of unsafe) {
    const { handler } = fixture({ buildUrl: () => value });
    const response = await handler(makeRequest());
    assert.equal(response.status, 503);
    assert.equal(JSON.stringify(await response.json()).includes("publish"), false);
  }
});

test("start response contains no sentinel admin key app secret token or business claim", async () => {
  const { handler } = fixture(); const response = await handler(makeRequest());
  const serialized = JSON.stringify({ body: await response.text(), headers: [...response.headers] });
  for (const sentinel of [ADMIN, "SENTINEL_APP_SECRET_DO_NOT_LEAK", "SENTINEL_TOKEN_DO_NOT_LEAK", "growthwise-dev"]) assert.equal(serialized.includes(sentinel), false);
});

test("start rate limit fails closed without creating another transaction", async () => {
  let allowed = true;
  const base = fixture({ rateLimiter: { consume: async () => { const value = allowed; allowed = false; return value; } } });
  assert.equal((await base.handler(makeRequest())).status, 200);
  assert.equal((await base.handler(makeRequest())).status, 429);
  assert.equal(base.creates.length, 1);
});

function callbackFixture(overrides = {}) {
  let claimed = false;
  const calls = { exchange: 0, connect: [], finish: [] };
  const transaction = { business_id: "growthwise-dev", return_destination_id: "growthwise-dev-integration" };
  const store = {
    claimTransaction: async () => { if (claimed) return null; claimed = true; return transaction; },
    connectCredential: async (value) => { calls.connect.push(value); },
    finishTransaction: async (value) => { calls.finish.push(value); },
  };
  const dependencies = {
    crypto: { transactionKey: (state) => { if (state !== "v1.valid.tag") throw new Error("bad"); return "derived-key"; } },
    store,
    config: () => ({ appId: "synthetic-app", appSecret: "SENTINEL_SECRET_DO_NOT_LEAK", callbackUri: `${ORIGIN}/callback`, publicOrigin: ORIGIN }),
    exchangeCode: async ({ code }) => { calls.exchange += 1; if (code === "fail") throw new Error("SENTINEL_PROVIDER_RAW"); return { accessToken: "SENTINEL_SHORT_TOKEN", accountId: "42" }; },
    exchangeLongLived: async () => ({ accessToken: "SENTINEL_LONG_TOKEN", expiresInSeconds: 3600, tokenType: "bearer" }),
    verifyIdentity: async () => ({ accountId: "42", username: "growth.wise1", name: "Growth Wise" }),
    now: () => new Date("2026-09-17T12:00:00.000Z"),
    ...overrides,
  };
  return { handler: createInstagramOAuthCallbackHandler(dependencies), calls, store, transaction };
}

function callbackRequest(query, options = {}) {
  return new Request(`${ORIGIN}/.netlify/functions/instagram-oauth-callback?${query}`, { method: options.method ?? "GET" });
}

test("callback diagnostics log only safe stage codes", async () => {
  const logs = [];
  const fixture = callbackFixture({ logger: { warn: (...values) => logs.push(values) } });
  const response = await fixture.handler(callbackRequest("state=bad&code=ok"));
  assert.equal(response.status, 400);
  assert.deepEqual(logs, [["instagram_oauth_callback_failed", { stage: "state_or_config" }]]);
  const serialized = JSON.stringify(logs);
  for (const value of ["SENTINEL_SECRET_DO_NOT_LEAK", "SENTINEL_SHORT_TOKEN", "derived-key", "v1.valid.tag"]) {
    assert.equal(serialized.includes(value), false);
  }
});

test("callback rejects missing duplicate malformed and bad-HMAC state before exchange", async () => {
  for (const query of ["code=ok", "state=v1.valid.tag&state=again&code=ok", "state=bad&code=ok", "state=v1.valid.tag", "state=v1.valid.tag&code=%ZZ", "state=v1.valid.tag&code=%C3%28"]) {
    const { handler, calls } = callbackFixture();
    const response = await handler(callbackRequest(query));
    assert.equal(response.status, 400);
    assert.equal(calls.exchange, 0);
  }
});

test("callback rejects an alternate deployment alias before claim or provider work", async () => {
  let claims = 0;
  const fixture = callbackFixture({ store: { claimTransaction: async () => { claims += 1; return null; } } });
  const response = await fixture.handler(new Request("https://alternate-alias.example/.netlify/functions/instagram-oauth-callback?state=v1.valid.tag&code=ok"));
  assert.equal(response.status, 400); assert.equal(claims, 0); assert.equal(fixture.calls.exchange, 0);
});

test("callback rejects expired and replayed state before exchange", async () => {
  const { handler, calls } = callbackFixture({ store: { claimTransaction: async () => null } });
  assert.equal((await handler(callbackRequest("state=v1.valid.tag&code=ok"))).status, 400);
  assert.equal(calls.exchange, 0);
});

test("concurrent callbacks produce one exchange and one credential write winner", async () => {
  const fixture = callbackFixture();
  const responses = await Promise.all([
    fixture.handler(callbackRequest("state=v1.valid.tag&code=ok")),
    fixture.handler(callbackRequest("state=v1.valid.tag&code=ok")),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [303, 400]);
  assert.equal(fixture.calls.exchange, 1);
  assert.equal(fixture.calls.connect.length, 1);
});

test("callback ignores or rejects a changed business_id and uses transaction tenant", async () => {
  const fixture = callbackFixture();
  assert.equal((await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok&business_id=dexters-hats"))).status, 400);
  assert.equal(fixture.calls.connect.length, 0);
});

test("unknown transaction return destination fails closed", async () => {
  const fixture = callbackFixture(); fixture.transaction.return_destination_id = "https://evil.example";
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"));
  assert.equal(response.status, 400); assert.equal(response.headers.has("location"), false); assert.equal(fixture.calls.exchange, 0);
});

test("provider denial consumes the transaction and redirects cancelled safely", async () => {
  const fixture = callbackFixture();
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&error=access_denied&error_reason=user_denied&error_description=no"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/instagram-dev.html?instagram=cancelled`);
  assert.equal(fixture.calls.finish[0].status, "consumed_denied"); assert.equal(fixture.calls.exchange, 0);
});

test("code exchange error consumes failed and redirects attention safely", async () => {
  const fixture = callbackFixture(); const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=fail"));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), `${ORIGIN}/instagram-dev.html?instagram=attention`);
  assert.equal(fixture.calls.finish[0].status, "consumed_failed");
});

test("provider raw error and sentinel secrets do not appear in response headers redirect logs or user errors", async () => {
  const logs = [];
  const fixture = callbackFixture({ logger: { warn: (...values) => logs.push(values) } });
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=fail"));
  const location = response.headers.get("location");
  assert.equal(location, `${ORIGIN}/instagram-dev.html?instagram=attention`);
  assert.deepEqual(logs, [["instagram_oauth_callback_failed", { stage: "provider_code_exchange" }]]);
  const serialized = JSON.stringify({ headers: [...response.headers], location, body: await response.text(), logs });
  for (const value of ["SENTINEL_PROVIDER_RAW", "SENTINEL_SECRET_DO_NOT_LEAK", "SENTINEL_SHORT_TOKEN", "derived-key"]) assert.equal(serialized.includes(value), false);
});

test("throwing callback logger cannot prevent failed finalization or the safe attention redirect", async () => {
  const fixture = callbackFixture({ logger: { warn: () => { throw new Error("LOGGER_FAILED"); } } });
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=fail"));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${ORIGIN}/instagram-dev.html?instagram=attention`);
  assert.equal(fixture.calls.finish.length, 1);
  assert.equal(fixture.calls.finish[0].status, "consumed_failed");
});

test("token-authenticated professional identity is authoritative when exchange metadata uses another ID", async () => {
  const logs = [];
  const fixture = callbackFixture({
    verifyIdentity: async () => ({ accountId: "99", username: "professional.account", name: "Professional Account" }),
    logger: { warn: (...values) => logs.push(values) },
  });
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"));
  assert.equal(response.headers.get("location"), `${ORIGIN}/instagram-dev.html?instagram=connected`);
  assert.equal(fixture.calls.connect[0].accountId, "99");
  assert.equal(fixture.calls.connect[0].username, "professional.account");
  assert.equal(fixture.calls.connect[0].payload.account_id, "99");
  assert.deepEqual(logs, []);
  const browserVisible = JSON.stringify({ headers: [...response.headers], body: await response.text(), logs });
  for (const value of ["42", "99", "professional.account", "SENTINEL_SHORT_TOKEN", "SENTINEL_LONG_TOKEN"]) {
    assert.equal(browserVisible.includes(value), false);
  }
});

test("empty or ambiguous Instagram identity is rejected without active binding", async () => {
  for (const identity of [
    null,
    { username: "missing.id" },
    { accountId: 42, username: "numeric.id" },
    { accountId: "42", username: "" },
  ]) {
    const fixture = callbackFixture({ verifyIdentity: async () => identity });
    await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok")); assert.equal(fixture.calls.connect.length, 0);
  }
});

test("duplicate account binding to a second tenant is rejected", async () => {
  const fixture = callbackFixture(); fixture.transaction.business_id = "dexters-hats";
  fixture.store.connectCredential = async () => { throw new Error("ACCOUNT_ALREADY_CONNECTED"); };
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"));
  assert.match(response.headers.get("location"), /instagram=attention$/); assert.equal(fixture.calls.finish[0].status, "consumed_failed");
});

test("successful callback encrypts binds and marks consumed_success", async () => {
  const fixture = callbackFixture(); const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"));
  assert.equal(response.status, 303); assert.equal(fixture.calls.connect[0].businessId, "growthwise-dev");
  assert.equal(fixture.calls.connect[0].payload.access_token, "SENTINEL_LONG_TOKEN");
  assert.equal(fixture.calls.connect[0].payload.scope, "instagram_business_basic");
  assert.equal(fixture.calls.connect[0].transactionKey, "derived-key");
  assert.equal(fixture.calls.finish.length, 0);
});

test("successful callback redirects only to fixed connected hint", async () => {
  const fixture = callbackFixture(); const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"));
  assert.equal(response.headers.get("location"), `${ORIGIN}/instagram-dev.html?instagram=connected`);
});

test("Dexter successful callback returns to the Dexter integration page", async () => {
  const fixture = callbackFixture(); fixture.transaction.business_id = "dexters-hats"; fixture.transaction.return_destination_id = "dexter-integration";
  const response = await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"));
  assert.equal(response.headers.get("location"), `${ORIGIN}/?instagram=connected`);
});

test("rolled-back credential binding never redirects connected", async () => {
  const fixture = callbackFixture(); fixture.store.connectCredential = async () => { throw new Error("rollback"); };
  assert.match((await fixture.handler(callbackRequest("state=v1.valid.tag&code=ok"))).headers.get("location"), /instagram=attention$/);
});

test("callback rejects duplicate unexpected query parameters and oversized query", async () => {
  for (const query of ["state=v1.valid.tag&code=ok&next=https://evil.example", "state=v1.valid.tag&code=ok&code=again", `state=v1.valid.tag&code=${"x".repeat(9000)}`]) {
    const fixture = callbackFixture(); assert.equal((await fixture.handler(callbackRequest(query))).status, 400); assert.equal(fixture.calls.exchange, 0);
  }
});
