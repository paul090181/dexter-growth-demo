import test from "node:test";
import assert from "node:assert/strict";
import { SQUARE_OAUTH_SCOPES } from "../../netlify/functions/_square-oauth.mjs";
import { createSquareOAuthStartHandler } from "../../netlify/functions/square-oauth-start.mjs";
import { createSquareOAuthCallbackHandler } from "../../netlify/functions/square-oauth-callback.mjs";

const origin = "https://deploy-preview-16--example.netlify.app";
const transactionKey = "a".repeat(64);

function settings(environment = "sandbox") {
  return {
    environment,
    applicationId: "sandbox-app-id",
    applicationSecret: "synthetic-secret",
    publicOrigin: origin,
    callbackUri: `${origin}/.netlify/functions/square-oauth-callback`,
    oauthBase: environment === "sandbox"
      ? "https://connect.squareupsandbox.com/oauth2"
      : "https://connect.squareup.com/oauth2",
    apiBase: environment === "sandbox"
      ? "https://connect.squareupsandbox.com"
      : "https://connect.squareup.com",
  };
}

function startRequest({
  businessId = "tenant-a",
  tenantKey = "gw_tenant_synthetic",
  requestOrigin = origin,
} = {}) {
  return new Request(`${requestOrigin}/.netlify/functions/square-oauth-start`, {
    method: "POST",
    headers: {
      origin: requestOrigin,
      "content-type": "application/json",
      "x-growthwise-tenant-key": tenantKey,
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ business_id: businessId }),
  });
}

test("Square OAuth start is tenant-authenticated and persists a server-bound transaction", async () => {
  const calls = [];
  const handler = createSquareOAuthStartHandler({
    config: () => settings(),
    authorize: async (_request, input) => {
      calls.push({ kind: "auth", input });
      return { ok: true, businessId: input.businessId };
    },
    crypto: {
      createState: () => ({
        state: "v1.synthetic-state.synthetic-tag",
        transactionKey,
      }),
    },
    store: {
      createTransactionWithFreshState: async (input) => {
        calls.push({ kind: "transaction", input });
        const generated = input.createState();
        assert.equal(generated.transactionKey, transactionKey);
        return { state: generated.state };
      },
    },
    rateLimiter: { consume: () => true },
    now: () => new Date("2026-09-25T14:30:00Z"),
  });

  const response = await handler(startRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  const authorization = new URL(body.authorization_url);

  assert.equal(authorization.origin, "https://connect.squareupsandbox.com");
  assert.equal(authorization.searchParams.get("scope"), SQUARE_OAUTH_SCOPES.join(" "));
  assert.equal(authorization.searchParams.has("session"), false);
  assert.equal(
    calls.find((call) => call.kind === "transaction").input.businessId,
    "tenant-a",
  );
  assert.equal(
    calls.find((call) => call.kind === "transaction").input.environment,
    "sandbox",
  );
});

test("Square OAuth start fails closed for wrong tenant or cross-origin request", async () => {
  const denied = createSquareOAuthStartHandler({
    config: () => settings(),
    authorize: async () => ({ ok: false, businessId: null }),
    rateLimiter: { consume: () => true },
  });
  assert.equal((await denied(startRequest())).status, 401);

  const crossOrigin = createSquareOAuthStartHandler({
    config: () => settings(),
    authorize: async () => ({ ok: true, businessId: "tenant-a" }),
    rateLimiter: { consume: () => true },
  });
  assert.equal(
    (await crossOrigin(startRequest({ requestOrigin: "https://evil.example" }))).status,
    403,
  );
});

test("Square OAuth start enforces the inventory connection entitlement", async () => {
  const locked = createSquareOAuthStartHandler({
    config: () => settings(),
    authorize: async () => ({ ok: false, via: "locked", businessId: null }),
    rateLimiter: { consume: () => true },
  });
  const lockedResponse = await locked(startRequest());
  assert.equal(lockedResponse.status, 403);
  assert.deepEqual(await lockedResponse.json(), {
    error: "Inventory connection is not included in this plan.",
  });

  const unavailable = createSquareOAuthStartHandler({
    config: () => settings(),
    authorize: async () => ({ ok: false, via: "unavailable", businessId: null }),
    rateLimiter: { consume: () => true },
  });
  assert.equal((await unavailable(startRequest())).status, 503);
});

test("Square OAuth start forbids production authorization on a deploy preview", async () => {
  const handler = createSquareOAuthStartHandler({
    config: () => settings("production"),
    authorize: async () => ({ ok: true, businessId: "tenant-a" }),
    rateLimiter: { consume: () => true },
  });
  const response = await handler(startRequest());
  assert.equal(response.status, 503);
});

function callbackRequest(query) {
  return new Request(
    `${origin}/.netlify/functions/square-oauth-callback?${query}`,
    { method: "GET" },
  );
}

test("Square OAuth callback stores only the transaction-bound tenant after merchant and scope verification", async () => {
  const calls = [];
  const handler = createSquareOAuthCallbackHandler({
    config: () => settings(),
    crypto: { transactionKey: () => transactionKey },
    store: {
      claimTransaction: async ({ transactionKey: key }) => {
        calls.push({ kind: "claim", key });
        return {
          transaction_key: key,
          business_id: "tenant-a",
          environment: "sandbox",
        };
      },
      connectCredential: async (input) => {
        calls.push({ kind: "connect", input });
        return { business_id: input.businessId };
      },
      finishTransaction: async (input) => {
        calls.push({ kind: "finish", input });
        return input;
      },
    },
    exchangeCode: async () => ({
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      merchantId: "MERCHANT123",
      tokenType: "bearer",
      expiresAt: new Date("2026-10-25T14:00:00Z"),
    }),
    tokenStatus: async () => ({
      merchantId: "MERCHANT123",
      scopes: [...SQUARE_OAUTH_SCOPES],
      expiresAt: new Date("2026-10-25T14:00:00Z"),
    }),
    merchantDetails: async () => ({
      merchantId: "MERCHANT123",
      displayName: "Second Business",
    }),
    now: () => new Date("2026-09-25T14:31:00Z"),
    logger: { warn() {} },
  });

  const response = await handler(
    callbackRequest("state=v1.synthetic.synthetic&code=synthetic-code&response_type=code"),
  );

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${origin}/app.html?square=connected`,
  );

  const connect = calls.find((call) => call.kind === "connect").input;
  assert.equal(connect.businessId, "tenant-a");
  assert.equal(connect.accountId, "MERCHANT123");
  assert.equal(connect.environment, "sandbox");
  assert.equal(connect.transactionKey, transactionKey);
  assert.equal(connect.payload.access_token, "synthetic-access");
  assert.equal(connect.payload.refresh_token, "synthetic-refresh");
  assert.deepEqual(connect.payload.scopes, SQUARE_OAUTH_SCOPES);
  assert.equal(calls.some((call) => call.kind === "finish"), false);
});

test("Square OAuth callback rejects incomplete success parameters", async () => {
  const handler = createSquareOAuthCallbackHandler({
    config: () => settings(),
    crypto: { transactionKey: () => transactionKey },
    store: { claimTransaction: async () => { throw new Error("must not claim"); } },
    logger: { warn() {} },
  });

  const response = await handler(
    callbackRequest("state=v1.synthetic.synthetic&code=synthetic-code"),
  );
  assert.equal(response.status, 400);
});

test("Square OAuth callback fails closed when required scopes are missing", async () => {
  const calls = [];
  const handler = createSquareOAuthCallbackHandler({
    config: () => settings(),
    crypto: { transactionKey: () => transactionKey },
    store: {
      claimTransaction: async () => ({
        business_id: "tenant-a",
        environment: "sandbox",
      }),
      connectCredential: async () => {
        throw new Error("must not connect");
      },
      finishTransaction: async (input) => {
        calls.push(input);
        return input;
      },
    },
    exchangeCode: async () => ({
      accessToken: "synthetic-access",
      refreshToken: "synthetic-refresh",
      merchantId: "MERCHANT123",
      tokenType: "bearer",
      expiresAt: new Date("2026-10-25T14:00:00Z"),
    }),
    tokenStatus: async () => ({
      merchantId: "MERCHANT123",
      scopes: ["MERCHANT_PROFILE_READ"],
    }),
    merchantDetails: async () => {
      throw new Error("must not verify merchant");
    },
    logger: { warn() {} },
  });

  const response = await handler(
    callbackRequest("state=v1.synthetic.synthetic&code=synthetic-code&response_type=code"),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${origin}/app.html?square=attention`);
  assert.equal(calls[0].status, "consumed_failed");
});

test("Square OAuth denial consumes the transaction and returns a safe cancelled redirect", async () => {
  const calls = [];
  const handler = createSquareOAuthCallbackHandler({
    config: () => settings(),
    crypto: { transactionKey: () => transactionKey },
    store: {
      claimTransaction: async () => ({
        business_id: "tenant-a",
        environment: "sandbox",
      }),
      finishTransaction: async (input) => {
        calls.push(input);
        return input;
      },
    },
    logger: { warn() {} },
  });

  const response = await handler(
    callbackRequest("state=v1.synthetic.synthetic&error=access_denied&error_description=user_denied"),
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), `${origin}/app.html?square=cancelled`);
  assert.equal(calls[0].status, "consumed_denied");
});

test("Square OAuth callback rejects replayed or environment-mismatched transactions", async () => {
  for (const transaction of [
    null,
    { business_id: "tenant-a", environment: "production" },
  ]) {
    const handler = createSquareOAuthCallbackHandler({
      config: () => settings(),
      crypto: { transactionKey: () => transactionKey },
      store: { claimTransaction: async () => transaction },
      logger: { warn() {} },
    });
    const response = await handler(
      callbackRequest("state=v1.synthetic.synthetic&code=synthetic-code&response_type=code"),
    );
    assert.equal(response.status, 400);
  }
});
