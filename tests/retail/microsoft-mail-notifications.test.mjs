import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  createMicrosoftMailSubscription,
} from "../../netlify/functions/_microsoft-mail-graph.mjs";
import {
  createAndStoreMicrosoftMailSubscription,
  validateMicrosoftMailNotification,
} from "../../netlify/functions/_microsoft-mail-subscriptions.mjs";
import {
  getMicrosoftMailAccess,
} from "../../netlify/functions/_microsoft-mail-access.mjs";
import {
  createMicrosoftMailWebhookHandler,
} from "../../netlify/functions/microsoft-mail-webhook.mjs";
import {
  createMicrosoftMailBackgroundHandler,
  processMicrosoftMailNotifications,
} from "../../netlify/functions/microsoft-mail-process-background.mjs";
import {
  renewDueMicrosoftMailSubscriptions,
  config as renewalConfig,
} from "../../netlify/functions/microsoft-mail-renew-subscriptions.mjs";

const ORIGIN = "https://preview.example";
const NOW = new Date("2026-09-23T20:00:00.000Z");
const DISPATCH_SECRET = "dispatch-secret-at-least-16";

test("Graph subscription creation watches only new Inbox messages and sends no resource data", async () => {
  let request;
  const result = await createMicrosoftMailSubscription({
    accessToken: "ACCESS",
    notificationUrl: `${ORIGIN}/.netlify/functions/microsoft-mail-webhook`,
    clientState: "client-state-secret",
    expirationDateTime: new Date("2026-09-30T19:00:00.000Z"),
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return new Response(JSON.stringify({
        id: "sub-123",
        resource: "me/mailFolders('Inbox')/messages",
        expirationDateTime: "2026-09-30T19:00:00.000Z",
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(request.url, "https://graph.microsoft.com/v1.0/subscriptions");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.Authorization, "Bearer ACCESS");
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body, {
    changeType: "created",
    notificationUrl: `${ORIGIN}/.netlify/functions/microsoft-mail-webhook`,
    resource: "me/mailFolders('Inbox')/messages",
    expirationDateTime: "2026-09-30T19:00:00.000Z",
    clientState: "client-state-secret",
    latestSupportedTlsVersion: "v1_2",
  });
  assert.equal(Object.hasOwn(body, "includeResourceData"), false);
  assert.equal(result.subscriptionId, "sub-123");
});

test("subscription manager stores only a hash of Graph clientState", async () => {
  const stored = [];
  let rawClientState = "";
  const row = await createAndStoreMicrosoftMailSubscription({
    businessId: "dexters-hats",
    accessToken: "ACCESS",
    publicOrigin: ORIGIN,
    store: {
      async upsertSubscription(value) {
        stored.push(value);
        return value;
      },
    },
    now: NOW,
    randomBytesImpl: (size) => Buffer.alloc(size, 4),
    createSubscription: async ({ clientState, notificationUrl, expirationDateTime }) => {
      rawClientState = clientState;
      assert.equal(notificationUrl, `${ORIGIN}/.netlify/functions/microsoft-mail-webhook`);
      assert.equal(
        expirationDateTime.toISOString(),
        "2026-09-30T19:00:00.000Z",
      );
      return {
        subscriptionId: "sub-123",
        resource: "me/mailFolders('Inbox')/messages",
        expiresAt: expirationDateTime,
      };
    },
  });

  assert.equal(rawClientState.length, 43);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].clientStateHash.length, 64);
  assert.notEqual(stored[0].clientStateHash, rawClientState);
  assert.equal(JSON.stringify(row).includes(rawClientState), false);
});

test("notification validation requires matching stored clientState and live subscription", async () => {
  const raw = Buffer.alloc(32, 7).toString("base64url");
  const crypto = await import("node:crypto");
  const hash = crypto.createHash("sha256").update(raw).digest("hex");
  const store = {
    async readSubscriptionById({ subscriptionId }) {
      return {
        business_id: "dexters-hats",
        subscription_id: subscriptionId,
        client_state_hash: hash,
        resource: "me/mailFolders('Inbox')/messages",
        status: "active",
        expires_at: new Date(NOW.getTime() + 60_000),
      };
    },
  };

  assert.equal((await validateMicrosoftMailNotification({
    subscriptionId: "sub-123",
    clientState: raw,
    store,
    now: NOW,
  })).business_id, "dexters-hats");

  assert.equal(await validateMicrosoftMailNotification({
    subscriptionId: "sub-123",
    clientState: "wrong",
    store,
    now: NOW,
  }), null);
});

test("webhook echoes Microsoft validation token as plain text without dispatching", async () => {
  let calls = 0;
  const handler = createMicrosoftMailWebhookHandler({
    publicOrigin: () => ORIGIN,
    dispatchSecret: () => DISPATCH_SECRET,
    fetchImpl: async () => { calls += 1; return new Response(null, { status: 202 }); },
  });

  const response = await handler(new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-webhook?validationToken=opaque%20token`,
    { method: "POST", headers: { "content-type": "text/plain" } },
  ));

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await response.text(), "opaque token");
  assert.equal(calls, 0);
});

test("webhook dispatches normal Graph notifications to the signed background function", async () => {
  const payload = JSON.stringify({
    value: [{
      subscriptionId: "sub-123",
      clientState: "state",
      changeType: "created",
      resourceData: { id: "message-123" },
    }],
  });
  let call;
  const handler = createMicrosoftMailWebhookHandler({
    publicOrigin: () => ORIGIN,
    dispatchSecret: () => DISPATCH_SECRET,
    fetchImpl: async (url, init) => {
      call = { url, init };
      return new Response(null, { status: 202 });
    },
  });

  const response = await handler(new Request(
    `${ORIGIN}/.netlify/functions/microsoft-mail-webhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    },
  ));

  assert.equal(response.status, 202);
  assert.equal(
    call.url,
    `${ORIGIN}/.netlify/functions/microsoft-mail-process-background`,
  );
  assert.equal(call.init.body, payload);

  const expected = createHmac("sha256", DISPATCH_SECRET)
    .update("growthwise-microsoft-mail-dispatch-v1\n", "utf8")
    .update(payload, "utf8")
    .digest("hex");
  assert.equal(call.init.headers["x-growthwise-dispatch-signature"], expected);
});

test("background function rejects unsigned direct invocation", async () => {
  let processed = false;
  const handler = createMicrosoftMailBackgroundHandler({
    dispatchSecret: () => DISPATCH_SECRET,
    processBatch: async () => { processed = true; },
  });

  await assert.rejects(
    handler(new Request(
      `${ORIGIN}/.netlify/functions/microsoft-mail-process-background`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-growthwise-dispatch-signature": "0".repeat(64),
        },
        body: JSON.stringify({ value: [{}] }),
      },
    )),
    /INVALID_DISPATCH_SIGNATURE/,
  );
  assert.equal(processed, false);
});

test("valid message notification becomes one read-only email lead in the unified inbox", async () => {
  const ingested = [];
  const touched = [];
  const result = await processMicrosoftMailNotifications({
    notifications: [{
      subscriptionId: "sub-123",
      clientState: "state",
      changeType: "created",
      resourceData: { id: "graph-message-123" },
    }],
    now: NOW,
    crypto: {},
    store: {
      async touchSubscriptionNotification(value) { touched.push(value); },
    },
    validateNotification: async () => ({
      business_id: "dexters-hats",
      subscription_id: "sub-123",
    }),
    access: async () => ({
      accessToken: "ACCESS",
      credential: { email_address: "sales@dextershats.example" },
    }),
    fetchMessage: async ({ messageId }) => ({
      id: messageId,
      conversationId: "thread-9",
      internetMessageId: "<message-9@example.com>",
      subject: "Blue fedora",
      body: { contentType: "text", content: "Do you still have size 7 1/4?" },
      bodyPreview: "Do you still have size 7 1/4?",
      receivedDateTime: "2026-09-23T19:59:00Z",
      from: {
        emailAddress: {
          name: "Maria Customer",
          address: "maria@example.com",
        },
      },
      replyTo: [{
        emailAddress: {
          name: "Maria Customer",
          address: "maria@example.com",
        },
      }],
      toRecipients: [],
      isDraft: false,
    }),
    ingest: async (payload, options) => {
      ingested.push({ payload, options });
      return { duplicate: false, lead: { id: "lead-1" } };
    },
  });

  assert.deepEqual(result, { processed: 1, ignored: 0, duplicates: 0 });
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].payload.business_id, "dexters-hats");
  assert.equal(ingested[0].payload.source_type, "email");
  assert.equal(ingested[0].payload.customer_contact, "maria@example.com");
  assert.equal(ingested[0].payload.source_account, "sales@dextershats.example");
  assert.equal(ingested[0].payload.reply_supported, false);
  assert.equal(ingested[0].payload.external_message_id, "<message-9@example.com>");
  assert.match(ingested[0].payload.message, /Blue fedora/);
  assert.match(ingested[0].payload.message, /size 7 1\/4/);
  assert.equal(ingested[0].options.ingestionTag, "microsoft-email");
  assert.equal(touched.length, 1);
});

test("expired access token refreshes and rotates encrypted server credential before use", async () => {
  const updates = [];
  const store = {
    async readDecryptedCredential() {
      return {
        status: "active",
        token_expires_at: new Date(NOW.getTime() - 1),
        email_address: "sales@example.com",
        payload: {
          account_id: "acct-1",
          access_token: "old-access",
          refresh_token: "old-refresh",
          token_type: "bearer",
          scope: ["User.Read", "Mail.Read"],
        },
      };
    },
    async updateCredentialToken(value) { updates.push(value); },
    async markCredentialStatus() { throw new Error("should not mark attention"); },
  };

  const result = await getMicrosoftMailAccess({
    businessId: "dexters-hats",
    now: NOW,
    crypto: {},
    store,
    config: { clientId: "client", clientSecret: "secret" },
    refreshToken: async ({ refreshToken }) => {
      assert.equal(refreshToken, "old-refresh");
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresInSeconds: 3600,
        tokenType: "bearer",
        scope: ["User.Read", "Mail.Read"],
      };
    },
  });

  assert.equal(result.accessToken, "new-access");
  assert.equal(result.refreshed, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.refresh_token, "new-refresh");
  assert.equal(updates[0].tokenExpiresAt.toISOString(), "2026-09-23T21:00:00.000Z");
});

test("scheduled renewal checks subscriptions within 48 hours and renews them", async () => {
  const renewed = [];
  const store = {
    async listSubscriptionsExpiringBefore({ before }) {
      assert.equal(before.toISOString(), "2026-09-25T20:00:00.000Z");
      return [{
        business_id: "dexters-hats",
        subscription_id: "sub-123",
      }];
    },
    async markSubscriptionStatus() { throw new Error("should not mark attention"); },
    async markCredentialStatus() { throw new Error("should not mark attention"); },
  };

  const result = await renewDueMicrosoftMailSubscriptions({
    now: NOW,
    crypto: {},
    store,
    config: { publicOrigin: ORIGIN },
    access: async () => ({ accessToken: "ACCESS" }),
    renewRecord: async (value) => { renewed.push(value); },
    logger: { warn() {} },
  });

  assert.deepEqual(result, {
    checked: 1,
    renewed: 1,
    recreated: 0,
    attention: 0,
  });
  assert.equal(renewed[0].subscription.subscription_id, "sub-123");
  assert.equal(renewalConfig.schedule, "0 */12 * * *");
});

test("subscription migration stores only hashed notification secret", async () => {
  const sql = await readFile(new URL(
    "../../netlify/database/migrations/20260923203000_microsoft-mail-subscriptions/migration.sql",
    import.meta.url,
  ), "utf8");
  assert.match(sql, /client_state_hash text NOT NULL/);
  assert.match(sql, /subscription_id text UNIQUE NOT NULL/);
  assert.match(sql, /status IN \('active', 'needs_attention', 'deleted'\)/);
  assert.doesNotMatch(sql, /client_state text/);
});
