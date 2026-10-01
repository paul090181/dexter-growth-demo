import assert from "node:assert/strict";
import test from "node:test";

import { createTenantBusinessAssistantHandler } from "../../netlify/functions/tenant-business-assistant.mjs";

const BUSINESS_ID = "north-star-books-abcdef123456";
const ORIGIN = "https://preview.example";

function request(body) {
  return new Request(ORIGIN + "/.netlify/functions/tenant-business-assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function providerResponse(result) {
  return new Response(JSON.stringify({
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(result) }],
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Narleo business assistant is tenant-bound and business-type-aware", async () => {
  let providerBody;
  const handler = createTenantBusinessAssistantHandler({
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    tenantStore: {
      async readTenantProfile({ businessId }) {
        return {
          business_id: businessId,
          business_name: "North Star Books",
          business_type: "retail",
        };
      },
    },
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
        };
      },
    },
    env: (name) => ({
      OPENAI_API_KEY: "server-key",
      OPENAI_BUSINESS_ASSISTANT_MODEL: "assistant-test-model",
    }[name] || ""),
    fetchImpl: async (_url, init) => {
      providerBody = JSON.parse(init.body);
      return providerResponse({
        answer: "Start by choosing one mystery display and giving it a clear weekly theme.",
        recommended_action: "Create one social post around that display and compare engagement with your usual posts.",
        context_status: "needs_more_business_data",
        data_needed: ["Recent sales by category"],
        suggested_follow_ups: [
          "What should I feature first?",
          "How often should I post?",
        ],
      });
    },
  });

  const response = await handler(request({
    business_id: BUSINESS_ID,
    question: "How can I get more attention for my mystery section?",
    history: [
      { role: "user", text: "I want more local traffic." },
      { role: "assistant", text: "We can test one focused promotion." },
    ],
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.business_id, BUSINESS_ID);
  assert.equal(body.business_type, "retail");
  assert.equal(body.context_status, "needs_more_business_data");
  assert.equal(body.data_needed[0], "Recent sales by category");
  assert.equal(JSON.stringify(body).includes("server-key"), false);

  assert.equal(providerBody.store, false);
  assert.equal(providerBody.model, "assistant-test-model");
  const prompt = providerBody.input[0].content[0].text;
  assert.match(prompt, /North Star Books/);
  assert.match(prompt, /retail shop/);
  assert.match(prompt, /I want more local traffic/);
  assert.match(prompt, /How can I get more attention/);
});

test("Narleo business assistant fails before AI for wrong tenant or inactive access", async () => {
  let providerCalls = 0;
  const unauthorized = createTenantBusinessAssistantHandler({
    authorize: async () => ({ ok: false, businessId: null }),
    tenantStore: {},
    billingStore: {},
    env: () => "unused",
    fetchImpl: async () => { providerCalls += 1; return providerResponse({}); },
  });
  assert.equal((await unauthorized(request({
    business_id: BUSINESS_ID,
    question: "Help me",
  }))).status, 401);
  assert.equal(providerCalls, 0);

  const locked = createTenantBusinessAssistantHandler({
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    tenantStore: {
      async readTenantProfile({ businessId }) {
        return { business_id: businessId, business_name: "North Star", business_type: "retail" };
      },
    },
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "past_due",
        };
      },
    },
    env: () => "unused",
    fetchImpl: async () => { providerCalls += 1; return providerResponse({}); },
  });
  assert.equal((await locked(request({
    business_id: BUSINESS_ID,
    question: "Help me",
  }))).status, 403);
  assert.equal(providerCalls, 0);
});

test("Narleo business assistant bounds history and rejects missing questions", async () => {
  let providerBody;
  const handler = createTenantBusinessAssistantHandler({
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    tenantStore: {
      async readTenantProfile({ businessId }) {
        return { business_id: businessId, business_name: "Service Co", business_type: "service" };
      },
    },
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
        };
      },
    },
    env: (name) => name === "OPENAI_API_KEY" ? "server-key" : "",
    fetchImpl: async (_url, init) => {
      providerBody = JSON.parse(init.body);
      return providerResponse({
        answer: "Answer",
        recommended_action: "Action",
        context_status: "enough_to_help",
        data_needed: [],
        suggested_follow_ups: ["Next?"],
      });
    },
  });

  const history = Array.from({ length: 10 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    text: "message-" + index,
  }));
  assert.equal((await handler(request({
    business_id: BUSINESS_ID,
    question: "What should I do next?",
    history,
  }))).status, 200);
  const prompt = providerBody.input[0].content[0].text;
  assert.doesNotMatch(prompt, /message-0/);
  assert.match(prompt, /message-9/);

  assert.equal((await handler(request({
    business_id: BUSINESS_ID,
    question: "",
  }))).status, 400);
});
