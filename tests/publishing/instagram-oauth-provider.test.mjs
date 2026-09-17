import test from "node:test";
import assert from "node:assert/strict";

import {
  INSTAGRAM_AUTHORIZATION_ENDPOINT,
  INSTAGRAM_IDENTITY_SCOPE,
  InstagramProviderError,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  exchangeLongLivedToken,
  verifyProfessionalIdentity,
} from "../../netlify/functions/_instagram-oauth.mjs";
import {
  getInstagramClient,
  resolveInstagramReturnDestination,
} from "../../netlify/functions/_instagram-clients.mjs";

const ORIGIN = "https://euphonious-beijinho-db4b4d.netlify.app";
const CALLBACK = `${ORIGIN}/.netlify/functions/instagram-oauth-callback`;

function response(body, { status = 200 } = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

test("client registry accepts configured GrowthWise and Dexter tenants only", () => {
  assert.equal(getInstagramClient("growthwise-dev").business_id, "growthwise-dev");
  assert.equal(getInstagramClient("dexters-hats").business_id, "dexters-hats");
  assert.throws(() => getInstagramClient("auto-city"), /not configured/i);
  assert.throws(() => getInstagramClient("__proto__"), /not configured/i);
});

test("authorization URL uses the exact callback minimum scope and opaque state", () => {
  const url = new URL(buildAuthorizationUrl({ appId: "123", callbackUri: CALLBACK, state: "v1.opaque.tag" }));
  assert.equal(url.origin + url.pathname, INSTAGRAM_AUTHORIZATION_ENDPOINT);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["client_id", "redirect_uri", "response_type", "scope", "state"]);
  assert.equal(url.searchParams.get("redirect_uri"), CALLBACK);
  assert.equal(url.searchParams.get("scope"), INSTAGRAM_IDENTITY_SCOPE);
  assert.equal(url.searchParams.get("state"), "v1.opaque.tag");
});

test("authorization URL has no business claim arbitrary return or publishing scope", () => {
  const serialized = buildAuthorizationUrl({ appId: "123", callbackUri: CALLBACK, state: "v1.opaque.tag" });
  assert.doesNotMatch(serialized, /business_id|return_to|code_challenge|content_publish|media/);
});

test("client registry assigns fixed allowlisted return destinations to GrowthWise and Dexter", () => {
  assert.equal(getInstagramClient("growthwise-dev").returnDestinationId, "growthwise-dev-integration");
  assert.equal(getInstagramClient("dexters-hats").returnDestinationId, "dexter-integration");
  assert.equal(resolveInstagramReturnDestination({ destinationId: "growthwise-dev-integration", hint: "connected", publicOrigin: ORIGIN }), `${ORIGIN}/instagram-dev.html?instagram=connected`);
  assert.equal(resolveInstagramReturnDestination({ destinationId: "dexter-integration", hint: "cancelled", publicOrigin: ORIGIN }), `${ORIGIN}/?instagram=cancelled`);
});

test("unknown return destination and unsafe hint fail closed", () => {
  assert.throws(() => resolveInstagramReturnDestination({ destinationId: "elsewhere", hint: "connected", publicOrigin: ORIGIN }), /return destination/i);
  assert.throws(() => resolveInstagramReturnDestination({ destinationId: "dexter-integration", hint: "https://evil.example", publicOrigin: ORIGIN }), /return hint/i);
  assert.throws(() => resolveInstagramReturnDestination({ destinationId: "dexter-integration", hint: "connected", publicOrigin: "http://example.test" }), /origin/i);
});

test("code exchange sends secrets server-side and enforces response size and schema", async () => {
  let request;
  const fetchImpl = async (url, init) => { request = { url, init }; return response({ access_token: "SYNTHETIC_SHORT_TOKEN", user_id: 42 }); };
  const token = await exchangeAuthorizationCode({ appId: "123", appSecret: "SYNTHETIC_APP_SECRET", callbackUri: CALLBACK, code: "SYNTHETIC_CODE", fetchImpl });
  assert.deepEqual(token, { accessToken: "SYNTHETIC_SHORT_TOKEN", accountId: "42" });
  assert.equal(request.url, "https://api.instagram.com/oauth/access_token");
  assert.equal(request.init.method, "POST");
  const form = new URLSearchParams(request.init.body);
  assert.equal(form.get("client_secret"), "SYNTHETIC_APP_SECRET");
  assert.equal(form.get("code"), "SYNTHETIC_CODE");
  await assert.rejects(exchangeAuthorizationCode({ appId: "1", appSecret: "x", callbackUri: CALLBACK, code: "c", maxResponseBytes: 10, fetchImpl: async () => response("x".repeat(11)) }), InstagramProviderError);
  await assert.rejects(exchangeAuthorizationCode({ appId: "1", appSecret: "x", callbackUri: CALLBACK, code: "c", fetchImpl: async () => response({ access_token: "x", extra: true }) }), /exchange failed/i);
  for (const userId of ["", " 42", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(exchangeAuthorizationCode({ appId: "1", appSecret: "x", callbackUri: CALLBACK, code: "c", fetchImpl: async () => response({ access_token: "x", user_id: userId }) }), /exchange failed/i);
  }
});

test("verified supported long-lived exchange normalizes token expiry", async () => {
  let requested;
  const result = await exchangeLongLivedToken({ appSecret: "SYNTHETIC_APP_SECRET", accessToken: "SYNTHETIC_SHORT_TOKEN", fetchImpl: async (url) => { requested = new URL(url); return response({ access_token: "SYNTHETIC_LONG_TOKEN", token_type: "bearer", expires_in: 5184000 }); } });
  assert.deepEqual(result, { accessToken: "SYNTHETIC_LONG_TOKEN", expiresInSeconds: 5184000, tokenType: "bearer" });
  assert.equal(requested.origin + requested.pathname, "https://graph.instagram.com/access_token");
  assert.equal(requested.searchParams.get("grant_type"), "ig_exchange_token");
  assert.equal(requested.searchParams.get("client_secret"), "SYNTHETIC_APP_SECRET");
});

test("professional identity requires one stable account ID and username", async () => {
  let requested;
  const identity = await verifyProfessionalIdentity({ accessToken: "SYNTHETIC_LONG_TOKEN", fetchImpl: async (url, init) => { requested = { url: new URL(url), init }; return response({ user_id: "1789", username: "growth.wise1" }); } });
  assert.deepEqual(identity, { accountId: "1789", username: "growth.wise1", name: "growth.wise1" });
  assert.equal(requested.url.origin + requested.url.pathname, "https://graph.instagram.com/me");
  assert.equal(requested.url.searchParams.get("fields"), "user_id,username");
  assert.equal(requested.init.headers.Authorization, "Bearer SYNTHETIC_LONG_TOKEN");
});

test("empty ambiguous and wrong-shaped identity responses fail closed", async () => {
  for (const body of [{}, [], { data: [{ user_id: "1", username: "one" }] }, { user_id: "1" }, { user_id: "1", username: "one", unexpected: true }, { user_id: "", username: "one" }, { user_id: " 1", username: "one" }, { user_id: -1, username: "one" }, { user_id: 1.5, username: "one" }, { user_id: Number.MAX_SAFE_INTEGER + 1, username: "one" }]) {
    await assert.rejects(verifyProfessionalIdentity({ accessToken: "token", fetchImpl: async () => response(body) }), (error) => error instanceof InstagramProviderError && error.code === "invalid_identity");
  }
});

test("identity HTTP failures distinguish invalid credentials from transient provider availability", async () => {
  for (const status of [401, 403, 400]) {
    await assert.rejects(
      verifyProfessionalIdentity({ accessToken: "token", fetchImpl: async () => response({ error: "raw" }, { status }) }),
      (error) => error instanceof InstagramProviderError && error.code === "invalid_identity",
    );
  }
  for (const status of [429, 500, 503]) {
    await assert.rejects(
      verifyProfessionalIdentity({ accessToken: "token", fetchImpl: async () => response({ error: "raw" }, { status }) }),
      (error) => error instanceof InstagramProviderError && error.code === "temporarily_unavailable",
    );
  }
  await assert.rejects(
    verifyProfessionalIdentity({ accessToken: "token", fetchImpl: async () => { throw new Error("network detail"); } }),
    (error) => error instanceof InstagramProviderError && error.code === "temporarily_unavailable",
  );
});

test("identity failure status remains authoritative when the raw error body is oversized", async () => {
  const oversized = "RAW_PROVIDER_SENTINEL".repeat(4_000);
  for (const [status, code] of [[401, "invalid_identity"], [403, "invalid_identity"], [429, "temporarily_unavailable"], [500, "temporarily_unavailable"], [503, "temporarily_unavailable"]]) {
    await assert.rejects(
      verifyProfessionalIdentity({ accessToken: "token", maxResponseBytes: 8, fetchImpl: async () => response(oversized, { status }) }),
      (error) => error instanceof InstagramProviderError
        && error.code === code
        && !String(error).includes("RAW_PROVIDER_SENTINEL"),
    );
  }
});

test("provider timeout and raw errors become safe normalized errors", async () => {
  const raw = "SENTINEL_RAW_PROVIDER_ERROR_DO_NOT_LEAK";
  for (const fetchImpl of [async () => { throw new Error(raw); }, async () => response(raw, { status: 500 })]) {
    await assert.rejects(exchangeAuthorizationCode({ appId: "1", appSecret: "secret", callbackUri: CALLBACK, code: "code", fetchImpl }), (error) => {
      assert.ok(error instanceof InstagramProviderError);
      assert.ok(["temporarily_unavailable", "exchange_failed"].includes(error.code));
      assert.doesNotMatch(String(error), new RegExp(raw));
      assert.equal(Object.hasOwn(error, "cause"), false);
      return true;
    });
  }
});
