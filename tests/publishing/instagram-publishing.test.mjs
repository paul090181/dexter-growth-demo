import test from "node:test";
import assert from "node:assert/strict";

import {
  createInstagramImageContainer,
  publishInstagramContainer,
  InstagramPublishError,
} from "../../netlify/functions/_instagram-publishing.mjs";
import { createInstagramPublishHandler } from "../../netlify/functions/instagram-publish.mjs";

function providerResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("Instagram provider creates an image container with bearer auth and no token in URL or body", async () => {
  let seen;
  const result = await createInstagramImageContainer({
    accountId: "17890001",
    accessToken: "SYNTHETIC_TOKEN",
    imageUrl: "https://growthwise.example/.netlify/functions/instagram-media?asset_id=abc",
    caption: "Reviewed caption",
    graphApiVersion: "v26.0",
    fetchImpl: async (url, init) => {
      seen = { url: new URL(url), init };
      return providerResponse({ id: "18000001" });
    },
  });

  assert.deepEqual(result, { containerId: "18000001" });
  assert.equal(seen.url.toString(), "https://graph.instagram.com/v26.0/17890001/media");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.Authorization, "Bearer SYNTHETIC_TOKEN");
  assert.equal(seen.init.body.get("image_url"), "https://growthwise.example/.netlify/functions/instagram-media?asset_id=abc");
  assert.equal(seen.init.body.get("caption"), "Reviewed caption");
  assert.equal(seen.init.body.has("access_token"), false);
  assert.equal(seen.url.searchParams.has("access_token"), false);
});

test("Instagram provider publishes only the supplied container", async () => {
  let seen;
  const result = await publishInstagramContainer({
    accountId: "17890001",
    accessToken: "SYNTHETIC_TOKEN",
    containerId: "18000001",
    graphApiVersion: "v26.0",
    fetchImpl: async (url, init) => {
      seen = { url: new URL(url), init };
      return providerResponse({ id: "17999999" });
    },
  });

  assert.deepEqual(result, { mediaId: "17999999" });
  assert.equal(seen.url.toString(), "https://graph.instagram.com/v26.0/17890001/media_publish");
  assert.equal(seen.init.body.get("creation_id"), "18000001");
  assert.equal(seen.init.body.has("access_token"), false);
});

test("Instagram provider normalizes transient failures without exposing provider bodies", async () => {
  await assert.rejects(
    createInstagramImageContainer({
      accountId: "17890001",
      accessToken: "SYNTHETIC_TOKEN",
      imageUrl: "https://growthwise.example/image.jpg",
      caption: "Reviewed",
      graphApiVersion: "v26.0",
      fetchImpl: async () => providerResponse({ error: "RAW_PROVIDER_SECRET" }, 503),
    }),
    (error) => error instanceof InstagramPublishError
      && error.code === "temporarily_unavailable"
      && !String(error).includes("RAW_PROVIDER_SECRET"),
  );
});

function publishFixture(overrides = {}) {
  const calls = { stage: 0, create: 0, publish: 0 };
  const clients = {
    "dexters-hats": {
      business_id: "dexters-hats",
      integrations: { instagram: { review_publish_enabled: true } },
    },
  };
  const handler = createInstagramPublishHandler({
    adminKey: () => "admin",
    clients,
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    graphApiVersion: "v26.0",
    store: {
      readCredential: async () => ({
        business_id: "dexters-hats",
        status: "active",
        account_binding_key: "binding",
        encrypted_credential: { algorithm: "A256GCM" },
        token_expires_at: "2026-10-20T12:00:00.000Z",
      }),
    },
    crypto: {
      decryptCredential: () => ({
        account_id: "17890001",
        access_token: "SYNTHETIC_TOKEN",
        scope: "instagram_business_basic,instagram_business_content_publish",
      }),
    },
    verifyIdentity: async () => ({ accountId: "17890001", username: "dexters.hats", name: "Dexter's Hats" }),
    stageImage: async () => {
      calls.stage += 1;
      return {
        assetId: "asset",
        publicUrl: "https://growthwise.example/.netlify/functions/instagram-media?asset_id=asset",
        expiresAt: new Date("2026-09-21T12:00:00.000Z"),
      };
    },
    createContainer: async () => {
      calls.create += 1;
      return { containerId: "18000001" };
    },
    publishContainer: async () => {
      calls.publish += 1;
      return { mediaId: "17999999" };
    },
    ...overrides,
  });
  return { handler, calls };
}

function request(body, { key = "admin" } = {}) {
  return new Request("https://growthwise.example/.netlify/functions/instagram-publish", {
    method: "POST",
    headers: { "content-type": "application/json", "x-growthwise-key": key },
    body: JSON.stringify(body),
  });
}

const validBody = {
  business_id: "dexters-hats",
  caption: "Reviewed Dexter promotion",
  image_data_url: "data:image/jpeg;base64,/9j/2Q==",
  reviewed: true,
};

test("publish endpoint requires explicit review before any media or provider call", async () => {
  const { handler, calls } = publishFixture();
  const response = await handler(request({ ...validBody, reviewed: false }));
  assert.equal(response.status, 400);
  assert.deepEqual(calls, { stage: 0, create: 0, publish: 0 });
});

test("publish endpoint fails closed when the saved authorization lacks publishing scope", async () => {
  const { handler, calls } = publishFixture({
    crypto: {
      decryptCredential: () => ({
        account_id: "17890001",
        access_token: "SYNTHETIC_TOKEN",
        scope: "instagram_business_basic",
      }),
    },
  });
  const response = await handler(request(validBody));
  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.code, "PUBLISHING_PERMISSION_REQUIRED");
  assert.deepEqual(calls, { stage: 0, create: 0, publish: 0 });
});

test("reviewed publish stages one image creates one container and sends one live publish", async () => {
  const { handler, calls } = publishFixture();
  const response = await handler(request(validBody));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.published, true);
  assert.equal(body.live_sent, true);
  assert.equal(body.media_id, "17999999");
  assert.equal(body.account.username, "dexters.hats");
  assert.deepEqual(calls, { stage: 1, create: 1, publish: 1 });
  assert.equal(JSON.stringify(body).includes("SYNTHETIC_TOKEN"), false);
});

test("container creation failure is safe to retry and never attempts final publish", async () => {
  const { handler, calls } = publishFixture({
    createContainer: async () => {
      calls.create += 1;
      throw new InstagramPublishError("temporarily_unavailable", { status: 503 });
    },
  });
  const response = await handler(request(validBody));
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.retry_safe, true);
  assert.deepEqual(calls, { stage: 1, create: 1, publish: 0 });
});

test("final publish failure is marked ambiguous so the UI cannot blindly retry and duplicate", async () => {
  const { handler, calls } = publishFixture({
    publishContainer: async () => {
      calls.publish += 1;
      throw new InstagramPublishError("publish_failed", { status: 500 });
    },
  });
  const response = await handler(request(validBody));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, "INSTAGRAM_PUBLISH_AMBIGUOUS");
  assert.equal(body.retry_safe, false);
  assert.deepEqual(calls, { stage: 1, create: 1, publish: 1 });
});
