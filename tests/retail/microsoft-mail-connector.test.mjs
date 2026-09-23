import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { createMicrosoftMailOAuthStartHandler } from "../../netlify/functions/microsoft-mail-oauth-start.mjs";
import { createMicrosoftMailOAuthCallbackHandler } from "../../netlify/functions/microsoft-mail-oauth-callback.mjs";
import { createMicrosoftMailConnectionHandler } from "../../netlify/functions/microsoft-mail-connection.mjs";
import { createMicrosoftMailDisconnectHandler } from "../../netlify/functions/microsoft-mail-disconnect.mjs";
import { createMicrosoftMailCrypto } from "../../netlify/functions/_microsoft-mail-crypto.mjs";
import { MICROSOFT_MAIL_SCOPES } from "../../netlify/functions/_microsoft-mail-oauth.mjs";

const ORIGIN = "https://preview.example";
const SESSION = `gw_conn_${"A".repeat(43)}`;
const NOW = new Date("2026-09-23T19:00:00.000Z");

function connectorAuthorize(request, { businessId, connector }) {
  if (!request.headers.get("cookie")?.includes(SESSION)
    || connector !== "email"
    || businessId !== "dexters-hats") {
    return { ok: false };
  }
  return { ok: true, businessId };
}

function startRequest(body = { business_id: "dexters-hats", mailbox_context: "business" }) {
  return new Request(`${ORIGIN}/.netlify/functions/microsoft-mail-oauth-start`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `__Host-gw_connector_session=${SESSION}`,
    },
    body: JSON.stringify(body),
  });
}

function oauthConfig() {
  return {
    clientId: "client",
    clientSecret: "secret",
    publicOrigin: ORIGIN,
    callbackUri: `${ORIGIN}/.netlify/functions/microsoft-mail-oauth-callback`,
  };
}

test("Microsoft email start requires explicit mailbox context and exact connector tenant", async () => {
  const creates = [];
  const handler = createMicrosoftMailOAuthStartHandler({
    connectorAuthorize,
    connectorStore: {},
    config: oauthConfig,
    now: () => NOW,
    rateLimiter: { consume: async () => true },
    crypto: { createState: () => ({ state: "v1.state.tag", nonceHash: "hash" }) },
    store: {
      async createTransactionWithFreshState(input) {
        creates.push(input);
        return { state: "v1.state.tag" };
      },
    },
  });

  assert.equal((await handler(startRequest({
    business_id: "dexters-hats",
    mailbox_context: "personal_acknowledged",
  }))).status, 200);

  assert.equal(creates[0].businessId, "dexters-hats");
  assert.equal(creates[0].mailboxContext, "personal_acknowledged");
  assert.equal(creates[0].expiresAt.toISOString(), "2026-09-23T19:10:00.000Z");

  assert.equal((await handler(startRequest({
    business_id: "dexters-hats",
    mailbox_context: "anything",
  }))).status, 400);

  assert.equal((await handler(startRequest({
    business_id: "another-shop",
    mailbox_context: "business",
  }))).status, 401);
});

test("Microsoft authorization URL remains read-only and uses the fixed callback", async () => {
  const handler = createMicrosoftMailOAuthStartHandler({
    connectorAuthorize,
    connectorStore: {},
    config: oauthConfig,
    now: () => NOW,
    rateLimiter: { consume: async () => true },
    crypto: { createState: () => ({ state: "v1.state.tag", nonceHash: "hash" }) },
    store: {
      async createTransactionWithFreshState() {
        return { state: "v1.state.tag" };
      },
    },
  });

  const response = await handler(startRequest());
  const body = await response.json();
  const url = new URL(body.authorization_url);

  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
  assert.equal(url.searchParams.get("scope"), MICROSOFT_MAIL_SCOPES.join(" "));
  assert.equal(
    url.searchParams.get("redirect_uri"),
    `${ORIGIN}/.netlify/functions/microsoft-mail-oauth-callback`,
  );
  assert.equal(url.searchParams.get("scope").includes("Mail.Send"), false);
  assert.equal(url.searchParams.get("scope").includes("Mail.ReadWrite"), false);
});

test("callback binds provider identity to the transaction tenant and preserves mailbox consent", async () => {
  const connected = [];
  let claimed = false;

  const handler = createMicrosoftMailOAuthCallbackHandler({
    config: oauthConfig,
    crypto: { transactionKey: () => "tx-key" },
    store: {
      async claimTransaction() {
        if (claimed) return null;
        claimed = true;
        return {
          business_id: "dexters-hats",
          mailbox_context: "personal_acknowledged",
          created_at: new Date("2026-09-23T18:58:00.000Z"),
        };
      },
      async connectCredential(value) { connected.push(value); },
      async finishTransaction() {},
    },
    exchangeCode: async () => ({
      accessToken: "ACCESS_SENTINEL",
      refreshToken: "REFRESH_SENTINEL",
      expiresInSeconds: 3600,
      tokenType: "bearer",
      scope: ["User.Read", "Mail.Read"],
    }),
    verifyIdentity: async () => ({
      accountId: "account-123",
      address: "dexter@hotmail.com",
      displayName: "Dexter",
    }),
    createSubscription: async ({ businessId, accessToken, publicOrigin, store, now }) => {
      assert.equal(businessId, "dexters-hats");
      assert.equal(accessToken, "ACCESS_SENTINEL");
      assert.equal(publicOrigin, ORIGIN);
      assert.ok(store);
      assert.equal(now.toISOString(), NOW.toISOString());
      return { business_id: businessId, subscription_id: "sub-123" };
    },
    now: () => NOW,
    logger: { warn() {} },
  });

  const response = await handler(new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-oauth-callback?state=v1.valid.tag&code=ok`,
  ));

  assert.equal(response.status, 303);
  assert.equal(
    response.headers.get("location"),
    `${ORIGIN}/connect-accounts.html?email=connected`,
  );
  assert.equal(connected.length, 1);
  assert.equal(connected[0].businessId, "dexters-hats");
  assert.equal(connected[0].mailboxContext, "personal_acknowledged");
  assert.equal(connected[0].emailAddress, "dexter@hotmail.com");
  assert.equal(
    connected[0].consentRecordedAt.toISOString(),
    "2026-09-23T18:58:00.000Z",
  );
  assert.equal(connected[0].payload.refresh_token, "REFRESH_SENTINEL");
});

test("callback replay or provider denial fails closed without credential write", async () => {
  let writes = 0;
  const base = {
    config: oauthConfig,
    crypto: { transactionKey: () => "tx-key" },
    exchangeCode: async () => { throw new Error("should not run"); },
    verifyIdentity: async () => { throw new Error("should not run"); },
    now: () => NOW,
    logger: { warn() {} },
  };

  const replay = createMicrosoftMailOAuthCallbackHandler({
    ...base,
    store: {
      async claimTransaction() { return null; },
      async connectCredential() { writes += 1; },
    },
  });

  assert.equal((await replay(new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-oauth-callback?state=v1.valid.tag&code=ok`,
  ))).status, 400);

  const finishes = [];
  const denied = createMicrosoftMailOAuthCallbackHandler({
    ...base,
    store: {
      async claimTransaction() {
        return {
          business_id: "dexters-hats",
          mailbox_context: "business",
          created_at: NOW,
        };
      },
      async finishTransaction(value) { finishes.push(value); },
      async connectCredential() { writes += 1; },
    },
  });

  const deniedResponse = await denied(new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-oauth-callback?state=v1.valid.tag&error=access_denied&error_description=no`,
  ));

  assert.equal(deniedResponse.status, 303);
  assert.equal(
    deniedResponse.headers.get("location"),
    `${ORIGIN}/connect-accounts.html?email=cancelled`,
  );
  assert.equal(finishes[0].status, "consumed_denied");
  assert.equal(writes, 0);
});

test("connection status exposes mailbox identity but never credentials", async () => {
  const handler = createMicrosoftMailConnectionHandler({
    connectorAuthorize,
    connectorStore: {},
    now: () => NOW,
    store: {
      async readCredential() {
        return {
          status: "active",
          email_address: "dexter@hotmail.com",
          display_name: "Dexter",
          encrypted_credential: { ciphertext: "SECRET" },
        };
      },
      async readSubscriptionByBusiness() {
        return {
          status: "active",
          subscription_id: "sub-123",
          expires_at: new Date(NOW.getTime() + 60 * 60 * 1000),
        };
      },
    },
    crypto: {},
  });

  const request = new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-connection?business_id=dexters-hats`,
    { headers: { cookie: `__Host-gw_connector_session=${SESSION}` } },
  );

  const response = await handler(request);
  const body = await response.json();

  assert.equal(body.state, "Connected");
  assert.equal(body.account.address, "dexter@hotmail.com");
  assert.equal(JSON.stringify(body).includes("SECRET"), false);
});

test("disconnect is tenant-bound and removes the stored credential", async () => {
  const deleted = [];
  const handler = createMicrosoftMailDisconnectHandler({
    connectorAuthorize,
    connectorStore: {},
    publicOrigin: () => ORIGIN,
    now: () => NOW,
    store: {
      async readSubscriptionByBusiness() { return null; },
      async deleteSubscriptionByBusiness(value) {
        deleted.push({ subscription: value });
      },
      async disconnectCredential(value) { deleted.push({ credential: value }); },
    },
    crypto: {},
  });

  const request = new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-disconnect`,
    {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: `__Host-gw_connector_session=${SESSION}`,
      },
      body: JSON.stringify({ business_id: "dexters-hats" }),
    },
  );

  const response = await handler(request);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(deleted, [
    { subscription: { businessId: "dexters-hats" } },
    { credential: { businessId: "dexters-hats" } },
  ]);
});

test("Microsoft mail crypto binds encrypted credentials to tenant and mailbox", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  const crypto = createMicrosoftMailCrypto({
    stateSecrets: { current: { id: "v1", key: "state-secret-at-least-16" } },
    bindingSecrets: { current: { id: "v1", key: "binding-secret-at-least-16" } },
    credentialKeys: { current: { id: "v1", key } },
    randomBytesImpl: (size) => Buffer.alloc(size, 9),
  });

  const binding = crypto.accountBindingKey("account-123");
  const encrypted = crypto.encryptCredential({
    businessId: "dexters-hats",
    accountId: "account-123",
    payload: { access_token: "secret-token" },
  });

  assert.deepEqual(
    crypto.decryptCredential({
      businessId: "dexters-hats",
      accountBindingKey: binding,
      encryptedToken: encrypted,
    }),
    { access_token: "secret-token" },
  );

  assert.throws(() => crypto.decryptCredential({
    businessId: "another-shop",
    accountBindingKey: binding,
    encryptedToken: encrypted,
  }), /CREDENTIAL_DECRYPT_FAILED/);
});

test("Microsoft mail migration keeps OAuth identity immutable and credentials encrypted", async () => {
  const sql = await readFile(new URL(
    "../../netlify/database/migrations/20260923190000_microsoft-mail-connector/migration.sql",
    import.meta.url,
  ), "utf8");

  assert.match(sql, /CREATE TABLE microsoft_mail_oauth_transactions/);
  assert.match(sql, /mailbox_context IN \('business', 'personal_acknowledged'\)/);
  assert.match(sql, /oauth transaction identity is immutable/);
  assert.match(sql, /CREATE TABLE microsoft_mail_credentials/);
  assert.match(sql, /encrypted_credential jsonb NOT NULL/);
  assert.match(sql, /account_binding_key text UNIQUE NOT NULL/);
  assert.match(sql, /consent_recorded_at timestamptz NOT NULL/);
  assert.doesNotMatch(sql, /access_token|refresh_token/);
});
