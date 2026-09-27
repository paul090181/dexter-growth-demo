import assert from "node:assert/strict";
import test from "node:test";

import { createTenantInstagramConnectionHandler } from "../../netlify/functions/tenant-instagram-connection.mjs";
import { createTenantInstagramPublishHandler } from "../../netlify/functions/tenant-instagram-publish.mjs";

const ORIGIN = "https://deploy-preview-18--euphonious-beijinho-db4b4d.netlify.app";
const BUSINESS_ID = "tierney-town-treats-abcdef123456";
const OTHER_ID = "other-business-abcdef123456";
const NOW = new Date("2026-09-27T17:00:00.000Z");

function allowed() {
  return async (_request, { businessId }) => ({
    ok: true,
    via: "tenant",
    businessId,
    entitlements: { feature_access: { automated_publishing: true } },
  });
}

function getRequest(id = BUSINESS_ID) {
  return new Request(
    ORIGIN + "/.netlify/functions/tenant-instagram-connection?business_id=" + encodeURIComponent(id),
    { method: "GET" },
  );
}

function postRequest(body) {
  return new Request(ORIGIN + "/.netlify/functions/tenant-instagram-publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("tenant Instagram status verifies only the authorized business and returns identity only", async () => {
  const calls = [];
  const handler = createTenantInstagramConnectionHandler({
    authorize: allowed(),
    now: () => NOW,
    instagramOptions: {
      env: () => undefined,
      logger: { warn() {} },
      readCredential: async ({ businessId }) => {
        calls.push({ stage: "read", businessId });
        return {
          business_id: businessId,
          status: "active",
          account_binding_key: "v1.binding",
          encrypted_credential: { algorithm: "A256GCM" },
          token_expires_at: "2026-10-27T17:00:00.000Z",
        };
      },
      crypto: {
        accountBindingKeys: () => ["v1.binding"],
        decryptCredential: () => ({
          account_id: "ig-123",
          access_token: "IG_SECRET",
          scope: [
            "instagram_business_basic",
            "instagram_business_content_publish",
          ],
        }),
      },
      verifyIdentity: async ({ accessToken }) => {
        assert.equal(accessToken, "IG_SECRET");
        return { accountId: "ig-123", username: "tierneytreats", name: "tierneytreats" };
      },
      updateCredentialHealth: async (input) => {
        calls.push({ stage: "health", ...input });
        return input;
      },
    },
  });

  const response = await handler(getRequest());
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.business_id, BUSINESS_ID);
  assert.equal(body.state, "Connected");
  assert.deepEqual(body.account, {
    username: "tierneytreats",
    name: "tierneytreats",
  });
  assert.equal(JSON.stringify(body).includes("IG_SECRET"), false);
  assert.equal(calls[0].businessId, BUSINESS_ID);
  assert.equal(calls.at(-1).status, "active");
});

test("tenant Instagram status fails before provider work for a mismatched tenant", async () => {
  let innerCalls = 0;
  const handler = createTenantInstagramConnectionHandler({
    authorize: async () => ({ ok: true, via: "tenant", businessId: OTHER_ID }),
    innerHandler: async () => {
      innerCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  const response = await handler(getRequest());
  assert.equal(response.status, 401);
  assert.equal(innerCalls, 0);
});

test("tenant Instagram publishing requires explicit review before media staging", async () => {
  const calls = { stage: 0, create: 0, wait: 0, publish: 0 };
  const handler = createTenantInstagramPublishHandler({
    authorize: allowed(),
    now: () => NOW,
    instagramOptions: {
      graphApiVersion: "v26.0",
      store: {
        async readCredential({ businessId }) {
          assert.equal(businessId, BUSINESS_ID);
          return {
            business_id: businessId,
            status: "active",
            account_binding_key: "binding",
            encrypted_credential: { algorithm: "A256GCM" },
            token_expires_at: "2026-10-27T17:00:00.000Z",
          };
        },
      },
      crypto: {
        decryptCredential: () => ({
          account_id: "ig-123",
          access_token: "IG_SECRET",
          scope: "instagram_business_basic,instagram_business_content_publish",
        }),
      },
      verifyIdentity: async () => ({
        accountId: "ig-123",
        username: "tierneytreats",
        name: "tierneytreats",
      }),
      stageImage: async () => {
        calls.stage += 1;
        return { publicUrl: ORIGIN + "/safe-image.jpg" };
      },
      createContainer: async () => {
        calls.create += 1;
        return { containerId: "container-1" };
      },
      waitForContainer: async () => {
        calls.wait += 1;
        return { statusCode: "FINISHED" };
      },
      publishContainer: async () => {
        calls.publish += 1;
        return { mediaId: "media-1" };
      },
      logger: { warn() {} },
    },
  });

  const response = await handler(postRequest({
    business_id: BUSINESS_ID,
    caption: "Draft only",
    image_data_url: "data:image/jpeg;base64,/9j/2Q==",
    reviewed: false,
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, { stage: 0, create: 0, wait: 0, publish: 0 });
});

test("tenant Instagram publishing sends one reviewed post using only that business's stored credential", async () => {
  const calls = { stage: 0, create: 0, wait: 0, publish: 0 };
  const handler = createTenantInstagramPublishHandler({
    authorize: allowed(),
    now: () => NOW,
    instagramOptions: {
      graphApiVersion: "v26.0",
      store: {
        async readCredential({ businessId }) {
          assert.equal(businessId, BUSINESS_ID);
          return {
            business_id: businessId,
            status: "active",
            account_binding_key: "binding",
            encrypted_credential: { algorithm: "A256GCM" },
            token_expires_at: "2026-10-27T17:00:00.000Z",
          };
        },
      },
      crypto: {
        decryptCredential: ({ businessId }) => {
          assert.equal(businessId, BUSINESS_ID);
          return {
            account_id: "ig-123",
            access_token: "IG_SECRET",
            scope: "instagram_business_basic,instagram_business_content_publish",
          };
        },
      },
      verifyIdentity: async ({ accessToken }) => {
        assert.equal(accessToken, "IG_SECRET");
        return { accountId: "ig-123", username: "tierneytreats", name: "tierneytreats" };
      },
      stageImage: async ({ businessId, imageDataUrl }) => {
        assert.equal(businessId, BUSINESS_ID);
        assert.match(imageDataUrl, /^data:image\/jpeg;base64,/);
        calls.stage += 1;
        return {
          publicUrl: ORIGIN + "/.netlify/functions/instagram-media?asset_id=safe",
        };
      },
      createContainer: async ({ accountId, accessToken, caption }) => {
        assert.equal(accountId, "ig-123");
        assert.equal(accessToken, "IG_SECRET");
        assert.equal(caption, "Reviewed seasonal cookie post");
        calls.create += 1;
        return { containerId: "container-1" };
      },
      waitForContainer: async ({ accessToken, containerId }) => {
        assert.equal(accessToken, "IG_SECRET");
        assert.equal(containerId, "container-1");
        calls.wait += 1;
        return { statusCode: "FINISHED" };
      },
      publishContainer: async ({ accountId, accessToken, containerId }) => {
        assert.equal(accountId, "ig-123");
        assert.equal(accessToken, "IG_SECRET");
        assert.equal(containerId, "container-1");
        calls.publish += 1;
        return { mediaId: "media-1" };
      },
      logger: { warn() {} },
    },
  });

  const response = await handler(postRequest({
    business_id: BUSINESS_ID,
    caption: "Reviewed seasonal cookie post",
    image_data_url: "data:image/jpeg;base64,/9j/2Q==",
    reviewed: true,
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, {
    ok: true,
    business_id: BUSINESS_ID,
    published: true,
    live_sent: true,
    media_id: "media-1",
    account: { username: "tierneytreats" },
  });
  assert.deepEqual(calls, { stage: 1, create: 1, wait: 1, publish: 1 });
  assert.equal(JSON.stringify(body).includes("IG_SECRET"), false);
});

test("tenant Instagram publishing blocks cross-tenant authorization before stored credentials are read", async () => {
  let innerCalls = 0;
  const handler = createTenantInstagramPublishHandler({
    authorize: async () => ({ ok: true, via: "tenant", businessId: OTHER_ID }),
    innerHandler: async () => {
      innerCalls += 1;
      return new Response("{}", { status: 200 });
    },
  });

  const response = await handler(postRequest({
    business_id: BUSINESS_ID,
    caption: "Reviewed",
    image_data_url: "data:image/jpeg;base64,/9j/2Q==",
    reviewed: true,
  }));
  assert.equal(response.status, 401);
  assert.equal(innerCalls, 0);
});

test("tenant Instagram publishing preserves safe reconnect and retry guidance without provider secrets", async () => {
  const handler = createTenantInstagramPublishHandler({
    authorize: allowed(),
    now: () => NOW,
    instagramOptions: {
      store: {
        async readCredential() {
          return {
            business_id: BUSINESS_ID,
            status: "active",
            account_binding_key: "binding",
            encrypted_credential: { algorithm: "A256GCM" },
            token_expires_at: "2026-10-27T17:00:00.000Z",
          };
        },
      },
      crypto: {
        decryptCredential: () => ({
          account_id: "ig-123",
          access_token: "IG_SECRET",
          scope: "instagram_business_basic",
        }),
      },
      logger: { warn() {} },
    },
  });

  const response = await handler(postRequest({
    business_id: BUSINESS_ID,
    caption: "Reviewed",
    image_data_url: "data:image/jpeg;base64,/9j/2Q==",
    reviewed: true,
  }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "PUBLISHING_PERMISSION_REQUIRED");
  assert.equal(JSON.stringify(body).includes("IG_SECRET"), false);
});
