import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  normalizeMetaWebhookPayload,
  parseMetaAccountMap,
  resolveMetaBusinessId,
  verifyMetaSignature,
} from "../../netlify/functions/_meta-webhook.mjs";
import { createMetaWebhookHandler } from "../../netlify/functions/meta-webhook.mjs";

const SECRET = "synthetic-meta-app-secret";
const VERIFY = "synthetic-webhook-verify-token";
const ACCOUNT_MAP = JSON.stringify({
  facebook: { "page-123": "dexters-hats" },
  instagram: { "ig-456": "dexters-hats" },
});

function signedRequest(payload, { map = ACCOUNT_MAP } = {}) {
  const raw = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
  const env = (name) => ({
    META_APP_SECRET: SECRET,
    META_WEBHOOK_VERIFY_TOKEN: VERIFY,
    GROWTHWISE_META_ACCOUNT_MAP: map,
  })[name] || "";
  return {
    request: new Request("https://growthwise.example/.netlify/functions/meta-webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body: raw,
    }),
    env,
  };
}

function facebookPayload() {
  return {
    object: "page",
    entry: [{
      id: "page-123",
      time: 1790000000000,
      messaging: [{
        sender: { id: "psid-customer-1" },
        recipient: { id: "page-123" },
        timestamp: 1790000000123,
        message: { mid: "fb-mid-1", text: "Do you still have the black Bailey hat?" },
      }],
    }],
  };
}

function instagramPayload() {
  return {
    object: "instagram",
    entry: [{
      id: "ig-456",
      time: 1790000000000,
      messaging: [{
        sender: { id: "igsid-customer-9" },
        recipient: { id: "ig-456" },
        timestamp: 1790000000456,
        message: { mid: "ig-mid-9", text: "Is this available?" },
      }],
    }],
  };
}

test("Meta account routing is explicit per provider account and business", () => {
  const map = parseMetaAccountMap(ACCOUNT_MAP);
  assert.equal(resolveMetaBusinessId({ accountMap: map, sourceType: "facebook", accountId: "page-123" }), "dexters-hats");
  assert.equal(resolveMetaBusinessId({ accountMap: map, sourceType: "instagram", accountId: "ig-456" }), "dexters-hats");
  assert.equal(resolveMetaBusinessId({ accountMap: map, sourceType: "facebook", accountId: "ig-456" }), null);
  assert.throws(() => parseMetaAccountMap("not-json"), /valid JSON/i);
});

test("Meta webhook signature verification uses the raw request body", () => {
  const rawBody = JSON.stringify(facebookPayload());
  const signature = `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
  assert.equal(verifyMetaSignature({ rawBody, signature, appSecret: SECRET }), true);
  assert.equal(verifyMetaSignature({ rawBody: `${rawBody} `, signature, appSecret: SECRET }), false);
  assert.equal(verifyMetaSignature({ rawBody, signature: "sha256=bad", appSecret: SECRET }), false);
});

test("Facebook Messenger events normalize into the GrowthWise inbox contract", () => {
  const result = normalizeMetaWebhookPayload(facebookPayload(), { accountMap: parseMetaAccountMap(ACCOUNT_MAP) });
  assert.equal(result.events.length, 1);
  assert.equal(result.unrouted.length, 0);
  assert.equal(result.events[0].business_id, "dexters-hats");
  assert.equal(result.events[0].source_type, "facebook");
  assert.equal(result.events[0].external_message_id, "fb-mid-1");
  assert.equal(result.events[0].external_thread_id, "facebook:page-123:psid-customer-1");
  assert.equal(result.events[0].reply_supported, false);
});

test("Instagram DM events normalize with a stable sender thread", () => {
  const result = normalizeMetaWebhookPayload(instagramPayload(), { accountMap: parseMetaAccountMap(ACCOUNT_MAP) });
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].source_type, "instagram");
  assert.equal(result.events[0].source, "Instagram DM");
  assert.equal(result.events[0].external_message_id, "ig-mid-9");
  assert.equal(result.events[0].external_thread_id, "instagram:ig-456:igsid-customer-9");
});

test("echoes and non-message delivery events do not become customer leads", () => {
  const payload = facebookPayload();
  payload.entry[0].messaging = [
    { sender: { id: "page-123" }, recipient: { id: "psid-customer-1" }, message: { mid: "echo", text: "sent", is_echo: true } },
    { sender: { id: "psid-customer-1" }, recipient: { id: "page-123" }, delivery: { mids: ["x"] } },
  ];
  const result = normalizeMetaWebhookPayload(payload, { accountMap: parseMetaAccountMap(ACCOUNT_MAP) });
  assert.equal(result.events.length, 0);
  assert.equal(result.ignored, 2);
});

test("attachment-only messages are retained without inventing product facts", () => {
  const payload = instagramPayload();
  payload.entry[0].messaging[0].message = {
    mid: "ig-image-1",
    attachments: [{ type: "image", payload: { url: "https://cdn.example.test/customer-image.jpg" } }],
  };
  const result = normalizeMetaWebhookPayload(payload, { accountMap: parseMetaAccountMap(ACCOUNT_MAP) });
  assert.equal(result.events[0].message, "Customer sent an image.");
  assert.equal(result.events[0].source_metadata.attachments[0].type, "image");
});

test("unmapped Meta accounts are fail-retryable instead of silently losing messages", async () => {
  const { request, env } = signedRequest(facebookPayload(), { map: JSON.stringify({ facebook: {}, instagram: {} }) });
  let ingestCalls = 0;
  const response = await createMetaWebhookHandler({
    env,
    ingest: async () => { ingestCalls += 1; },
    logger: { info() {}, warn() {} },
  })(request);
  assert.equal(response.status, 503);
  assert.equal(ingestCalls, 0);
});

test("webhook verification returns Meta challenge only for the configured token", async () => {
  const env = (name) => name === "META_WEBHOOK_VERIFY_TOKEN" ? VERIFY : "";
  const handler = createMetaWebhookHandler({ env });
  const good = await handler(new Request(`https://growthwise.example/.netlify/functions/meta-webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=123456`, { method: "GET" }));
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "123456");
  const bad = await handler(new Request("https://growthwise.example/.netlify/functions/meta-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123456", { method: "GET" }));
  assert.equal(bad.status, 403);
});

test("valid signed webhook feeds the shared ingest path and duplicate results stay replay-safe", async () => {
  const seen = new Set();
  const ingest = async (event) => {
    const duplicate = seen.has(event.external_message_id);
    seen.add(event.external_message_id);
    return { duplicate, lead: { id: event.external_message_id } };
  };
  for (const expectedDuplicate of [false, true]) {
    const { request, env } = signedRequest(facebookPayload());
    const response = await createMetaWebhookHandler({ env, ingest, logger: { info() {}, warn() {} } })(request);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.duplicates, expectedDuplicate ? 1 : 0);
  }
});

test("invalid webhook signature is rejected before ingest", async () => {
  const env = (name) => ({ META_APP_SECRET: SECRET, GROWTHWISE_META_ACCOUNT_MAP: ACCOUNT_MAP })[name] || "";
  let called = false;
  const request = new Request("https://growthwise.example/.netlify/functions/meta-webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` },
    body: JSON.stringify(facebookPayload()),
  });
  const response = await createMetaWebhookHandler({ env, ingest: async () => { called = true; } })(request);
  assert.equal(response.status, 401);
  assert.equal(called, false);
});
