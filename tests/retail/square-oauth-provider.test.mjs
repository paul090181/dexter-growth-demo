import test from "node:test";
import assert from "node:assert/strict";
import {
  SQUARE_API_VERSION,
  SQUARE_OAUTH_SCOPES,
  buildSquareAuthorizationUrl,
  exchangeSquareAuthorizationCode,
  refreshSquareAccessToken,
  retrieveSquareMerchant,
  retrieveSquareTokenStatus,
  squareCallbackUri,
} from "../../netlify/functions/_square-oauth.mjs";

test("Square authorization URL uses the sandbox host and least-privilege read scopes", () => {
  const state = "v1.synthetic-state.synthetic-tag";
  const url = new URL(buildSquareAuthorizationUrl({
    applicationId: "sandbox-app-id",
    environment: "sandbox",
    state,
  }));

  assert.equal(url.origin, "https://connect.squareupsandbox.com");
  assert.equal(url.pathname, "/oauth2/authorize");
  assert.equal(url.searchParams.get("client_id"), "sandbox-app-id");
  assert.equal(url.searchParams.get("scope"), SQUARE_OAUTH_SCOPES.join(" "));
  assert.equal(url.searchParams.get("session"), "false");
  assert.equal(url.searchParams.get("state"), state);
  assert.deepEqual(SQUARE_OAUTH_SCOPES, [
    "MERCHANT_PROFILE_READ",
    "ITEMS_READ",
    "INVENTORY_READ",
    "ORDERS_READ",
  ]);
});

test("Square authorization URL uses the production host only when explicitly configured", () => {
  const url = new URL(buildSquareAuthorizationUrl({
    applicationId: "production-app-id",
    environment: "production",
    state: "v1.synthetic-state.synthetic-tag",
  }));
  assert.equal(url.origin, "https://connect.squareup.com");
});

test("Square callback URI requires an exact HTTPS origin", () => {
  assert.equal(
    squareCallbackUri("https://deploy-preview-16--example.netlify.app"),
    "https://deploy-preview-16--example.netlify.app/.netlify/functions/square-oauth-callback",
  );
  assert.throws(() => squareCallbackUri("http://example.test"), /Invalid public origin/);
  assert.throws(() => squareCallbackUri("https://example.test/path"), /Invalid public origin/);
});

test("Square code exchange posts credentials only in the JSON body and validates merchant token fields", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      merchant_id: "MERCHANT123",
      token_type: "bearer",
      expires_at: "2026-10-25T14:00:00Z",
    }), { status: 200 });
  };

  const token = await exchangeSquareAuthorizationCode({
    applicationId: "sandbox-app-id",
    applicationSecret: "synthetic-app-secret",
    environment: "sandbox",
    code: "synthetic-code",
    fetchImpl,
  });

  assert.equal(token.merchantId, "MERCHANT123");
  assert.equal(token.tokenType, "bearer");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://connect.squareupsandbox.com/oauth2/token");
  assert.equal(calls[0].init.headers["Square-Version"], SQUARE_API_VERSION);
  assert.equal(calls[0].url.includes("synthetic-app-secret"), false);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    client_id: "sandbox-app-id",
    client_secret: "synthetic-app-secret",
    code: "synthetic-code",
    grant_type: "authorization_code",
  });
});

test("Square token status verifies scopes with bearer authorization", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      merchant_id: "MERCHANT123",
      scopes: [...SQUARE_OAUTH_SCOPES],
      expires_at: "2026-10-25T14:00:00Z",
    }), { status: 200 });
  };

  const status = await retrieveSquareTokenStatus({
    accessToken: "synthetic-access-token",
    environment: "sandbox",
    fetchImpl,
  });

  assert.equal(status.merchantId, "MERCHANT123");
  assert.deepEqual(status.scopes, SQUARE_OAUTH_SCOPES);
  assert.equal(calls[0].url, "https://connect.squareupsandbox.com/oauth2/token/status");
  assert.equal(calls[0].init.headers.authorization, "Bearer synthetic-access-token");
});

test("Square merchant verification uses the scoped access token and authoritative merchant ID", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      merchant: {
        id: "MERCHANT123",
        business_name: "Second Business",
      },
    }), { status: 200 });
  };

  const merchant = await retrieveSquareMerchant({
    accessToken: "synthetic-access-token",
    merchantId: "MERCHANT123",
    environment: "sandbox",
    fetchImpl,
  });

  assert.deepEqual(merchant, {
    merchantId: "MERCHANT123",
    displayName: "Second Business",
  });
  assert.equal(
    calls[0].url,
    "https://connect.squareupsandbox.com/v2/merchants/MERCHANT123",
  );
  assert.equal(calls[0].init.headers.authorization, "Bearer synthetic-access-token");
});

test("Square refresh exchanges only the stored refresh token for the same merchant", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({
      access_token: "access-two",
      refresh_token: "refresh-two",
      merchant_id: "MERCHANT123",
      token_type: "bearer",
      expires_at: "2026-10-25T14:00:00Z",
    }), { status: 200 });
  };

  const refreshed = await refreshSquareAccessToken({
    applicationId: "sandbox-app-id",
    applicationSecret: "synthetic-app-secret",
    environment: "sandbox",
    refreshToken: "refresh-one",
    fetchImpl,
  });

  assert.equal(refreshed.merchantId, "MERCHANT123");
  assert.equal(refreshed.accessToken, "access-two");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    client_id: "sandbox-app-id",
    client_secret: "synthetic-app-secret",
    refresh_token: "refresh-one",
    grant_type: "refresh_token",
  });
});
