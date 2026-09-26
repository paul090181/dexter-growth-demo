import assert from "node:assert/strict";
import test from "node:test";

import { createOnboardingEventHandler } from "../../netlify/functions/onboarding-event.mjs";

const URL = "https://preview.example/.netlify/functions/onboarding-event";
const BUSINESS_ID = "north-star-books";

function request(body, tenantKey = "tenant-key") {
  return new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-tenant-key": tenantKey,
    },
    body: JSON.stringify(body),
  });
}

test("tenant can record an approved onboarding milestone only for itself", async () => {
  const calls = [];
  const handler = createOnboardingEventHandler({
    tenantStore: {},
    authorize: async (_request, { businessId }) => ({
      ok: businessId === BUSINESS_ID,
      businessId: BUSINESS_ID,
      via: "tenant",
    }),
    analyticsStore: {
      recordEvent: async (input) => {
        calls.push(input);
        return input;
      },
    },
    now: () => new Date("2026-09-25T20:00:00.000Z"),
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    event_name: "business_pulse_loaded",
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    event_name: "business_pulse_loaded",
    recorded: true,
  });
  assert.equal(calls[0].businessId, BUSINESS_ID);
  assert.equal(calls[0].eventName, "business_pulse_loaded");
});

test("one tenant cannot record another tenant's milestone", async () => {
  let writes = 0;
  const handler = createOnboardingEventHandler({
    tenantStore: {},
    authorize: async () => ({ ok: false, businessId: null }),
    analyticsStore: { recordEvent: async () => { writes += 1; } },
  });

  const response = await handler(request({
    business_id: "other-business",
    event_name: "workspace_opened",
  }));
  assert.equal(response.status, 401);
  assert.equal(writes, 0);
});

test("onboarding event endpoint rejects arbitrary analytics payloads", async () => {
  let writes = 0;
  const handler = createOnboardingEventHandler({
    tenantStore: {},
    authorize: async () => ({ ok: true, businessId: BUSINESS_ID }),
    analyticsStore: { recordEvent: async () => { writes += 1; } },
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    event_name: "customer_message_text",
    message: "private text",
  }));
  assert.equal(response.status, 400);
  assert.equal(writes, 0);
});
