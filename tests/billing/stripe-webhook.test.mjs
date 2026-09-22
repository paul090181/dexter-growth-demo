import assert from "node:assert/strict";
import test from "node:test";

import { createStripeWebhookHandler } from "../../netlify/functions/stripe-webhook.mjs";

const URL = "https://preview.example/.netlify/functions/stripe-webhook";

function signedRequest(raw = '{"id":"evt_1"}', options = {}) {
  return new Request(URL, {
    method: options.method || "POST",
    headers: options.signature === false ? {} : { "stripe-signature": options.signature || "sig_test" },
    body: options.method === "GET" ? undefined : raw,
  });
}

function fixture(overrides = {}) {
  const processed = [];
  const logs = [];
  let verifiedBody;
  const event = { id: "evt_1", type: "product.updated", created: 1790020800, data: { object: {} } };
  const billingService = {
    processEvent: async (value) => {
      processed.push(value);
      return { outcome: "ignored" };
    },
  };
  const handler = createStripeWebhookHandler({
    constructEvent: (raw) => {
      verifiedBody = raw;
      return event;
    },
    billingService,
    webhookSecret: "test-signing-secret",
    logger: { error: (...args) => logs.push(args) },
    ...overrides,
  });
  return { handler, processed, logs, billingService, verifiedBody: () => verifiedBody };
}

test("invalid signatures are rejected before processing", async () => {
  const { handler, processed } = fixture({ constructEvent: () => { throw new Error("bad signature"); } });
  const response = await handler(signedRequest());

  assert.equal(response.status, 400);
  assert.equal(processed.length, 0);
});

test("the unchanged raw body reaches signature verification", async () => {
  const raw = '{ "id": "evt_1", "type": "product.updated" }';
  const state = fixture();
  await state.handler(signedRequest(raw));

  assert.equal(state.verifiedBody(), raw);
});

test("duplicates and ignored events return HTTP 200", async () => {
  for (const outcome of ["duplicate", "ignored", "stale", "processed"]) {
    const { handler } = fixture({ billingService: { processEvent: async () => ({ outcome }) } });
    const response = await handler(signedRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: true, outcome });
  }
});

test("webhook allows only POST", async () => {
  const { handler, processed } = fixture();
  const response = await handler(signedRequest("", { method: "GET" }));

  assert.equal(response.status, 405);
  assert.equal(processed.length, 0);
});

test("missing webhook configuration fails closed", async () => {
  const { handler, processed } = fixture({ webhookSecret: "" });
  const response = await handler(signedRequest());

  assert.equal(response.status, 503);
  assert.equal(processed.length, 0);
});

test("missing Stripe signature is rejected before verification", async () => {
  let verified = false;
  const { handler } = fixture({ constructEvent: () => { verified = true; } });
  const response = await handler(signedRequest("{}", { signature: false }));

  assert.equal(response.status, 400);
  assert.equal(verified, false);
});

test("oversized webhook bodies are rejected before verification", async () => {
  let verified = false;
  const { handler, processed } = fixture({ constructEvent: () => { verified = true; } });
  const response = await handler(signedRequest("x".repeat(256_001)));

  assert.equal(response.status, 413);
  assert.equal(verified, false);
  assert.equal(processed.length, 0);
});

test("processing failures produce a retryable response and safe structured log", async () => {
  const sensitive = "database password and payload";
  const state = fixture({ billingService: { processEvent: async () => { throw new Error(sensitive); } } });
  const response = await state.handler(signedRequest());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Webhook processing failed." });
  assert.equal(state.logs.length, 1);
  assert.equal(state.logs[0][0], "stripe_webhook_failed");
  assert.deepEqual(state.logs[0][1], {
    event_id: "evt_1",
    event_type: "product.updated",
    code: "WEBHOOK_PROCESSING_FAILED",
  });
  assert.doesNotMatch(JSON.stringify(state.logs), /database password|payload/);
});
