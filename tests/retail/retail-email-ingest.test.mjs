import assert from "node:assert/strict";
import test from "node:test";

import {
  createRetailEmailIngestHandler,
  normalizeRetailEmailPayload,
} from "../../netlify/functions/retail-email-ingest.mjs";

const URL = "https://preview.example/.netlify/functions/retail-email-ingest";

function request(body, { key = "email-secret", method = "POST" } = {}) {
  return new Request(URL, {
    method,
    headers: {
      "content-type": "application/json",
      "x-growthwise-ingest-key": key,
    },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
}

test("email payload normalizes into the existing unified inbox contract", () => {
  assert.deepEqual(
    normalizeRetailEmailPayload({
      business_id: "dexters-hats",
      message_id: "<msg-123@example.com>",
      thread_id: "thread-9",
      from: "Maria Customer <maria@example.com>",
      to: "leads@example.test",
      reply_to: "maria+reply@example.com",
      subject: "Blue fedora availability",
      text: "Do you still have the blue fedora in stock?",
      received_at: "2026-09-23T18:00:00Z",
    }),
    {
      business_id: "dexters-hats",
      source_type: "email",
      source: "Email",
      customer_name: "Maria Customer",
      customer_contact: "maria@example.com",
      message: "Subject: Blue fedora availability\n\nDo you still have the blue fedora in stock?",
      source_account: "leads@example.test",
      external_thread_id: "thread-9",
      external_message_id: "<msg-123@example.com>",
      reply_target: "maria+reply@example.com",
      reply_supported: false,
      received_at: "2026-09-23T18:00:00Z",
      source_metadata: {
        subject: "Blue fedora availability",
        to: "leads@example.test",
        reply_to: "maria+reply@example.com",
        has_plain_text: true,
      },
    },
  );
});

test("email intake authenticates before storing anything", async () => {
  let calls = 0;
  const handler = createRetailEmailIngestHandler({
    ingest: async () => { calls += 1; },
    getAdminKey: () => "admin-secret",
    getIngestKey: () => "email-secret",
  });

  const response = await handler(request({
    business_id: "dexters-hats",
    from: "maria@example.com",
    text: "Hello",
  }, { key: "wrong" }));

  assert.equal(response.status, 401);
  assert.equal(calls, 0);
});

test("authenticated email enters the unified inbox with email source and no outbound sending", async () => {
  const calls = [];
  const handler = createRetailEmailIngestHandler({
    ingest: async (payload, options) => {
      calls.push({ payload, options });
      return { duplicate: false, lead: { id: "lead-123" } };
    },
    getAdminKey: () => "admin-secret",
    getIngestKey: () => "email-secret",
  });

  const response = await handler(request({
    business_id: "dexters-hats",
    message_id: "msg-123",
    from: { name: "Maria", email: "maria@example.com" },
    to: "dexter@example.test",
    subject: "Hat question",
    text: "Do you have this in size 7 1/4?",
  }));

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    ok: true,
    duplicate: false,
    id: "lead-123",
    source_type: "email",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.source_type, "email");
  assert.equal(calls[0].payload.reply_supported, false);
  assert.equal(calls[0].options.ingestionTag, "email");
});

test("duplicate provider message remains a single inbox lead", async () => {
  const handler = createRetailEmailIngestHandler({
    ingest: async () => ({ duplicate: true, lead: { id: "lead-existing" } }),
    getAdminKey: () => "",
    getIngestKey: () => "email-secret",
  });

  const response = await handler(request({
    business_id: "dexters-hats",
    message_id: "msg-123",
    from: "maria@example.com",
    subject: "Same message",
  }));

  assert.equal(response.status, 200);
  assert.equal((await response.json()).duplicate, true);
});

test("email intake requires sender and message content", () => {
  assert.throws(
    () => normalizeRetailEmailPayload({ business_id: "dexters-hats", text: "Hello" }),
    /sender email/i,
  );
  assert.throws(
    () => normalizeRetailEmailPayload({ business_id: "dexters-hats", from: "maria@example.com" }),
    /subject or plain-text body/i,
  );
});

test("email intake rejects unsupported method and oversized body", async () => {
  const handler = createRetailEmailIngestHandler({
    ingest: async () => ({ duplicate: false, lead: { id: "nope" } }),
    getAdminKey: () => "",
    getIngestKey: () => "email-secret",
  });

  assert.equal((await handler(request({}, { method: "GET" }))).status, 405);

  const oversized = new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-ingest-key": "email-secret",
    },
    body: JSON.stringify({
      business_id: "dexters-hats",
      from: "maria@example.com",
      text: "x".repeat(140 * 1024),
    }),
  });
  assert.equal((await handler(oversized)).status, 413);
});

test("email adapter minimizes stored provider data and never stores HTML or raw headers", () => {
  const normalized = normalizeRetailEmailPayload({
    business_id: "dexters-hats",
    from: "maria@example.com",
    to: "leads@example.test",
    subject: "Question",
    text: "Plain text body",
    html: "<script>secret()</script>",
    headers: { authorization: "should-not-be-stored" },
    attachments: [{ name: "private.pdf" }],
  });

  const serialized = JSON.stringify(normalized);
  assert.doesNotMatch(serialized, /script|authorization|private\.pdf/);
  assert.equal(normalized.source_metadata.has_plain_text, true);
});
