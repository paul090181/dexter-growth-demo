import assert from "node:assert/strict";
import test from "node:test";

import { createTenantFirstWinHandler } from "../../netlify/functions/tenant-first-win.mjs";

const ORIGIN = "https://preview.example";
const BUSINESS_ID = "tierney-town-treats-abcdef123456";

function request(body) {
  return new Request(ORIGIN + "/.netlify/functions/tenant-first-win", {
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

function fixture({
  businessType = "bakery_food",
  featureAccess = { promotion_content: true, lead_reply_drafting: true },
  authorized = true,
} = {}) {
  let providerBody = null;
  const handler = createTenantFirstWinHandler({
    authorize: async (_request, { businessId }) => authorized
      ? { ok: true, businessId }
      : { ok: false, businessId: null },
    tenantStore: {
      async readTenantProfile({ businessId }) {
        return {
          business_id: businessId,
          business_name: "Tierney Town Treats",
          business_type: businessType,
        };
      },
    },
    billingStore: {
      async readSubscription() {
        return {
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: featureAccess.promotion_content || featureAccess.lead_reply_drafting
            ? "starter_monthly"
            : "unknown",
          status: "active",
        };
      },
    },
    env: (name) => ({
      OPENAI_API_KEY: "server-ai-key",
      OPENAI_MARKETING_MODEL: "test-model",
    }[name] || ""),
    fetchImpl: async (_url, init) => {
      providerBody = JSON.parse(init.body);
      return providerResponse({
        title: "Fall cookie spotlight",
        primary_text: "Fresh fall cookie designs are here.",
        secondary_text: "Fall cookie season is here.",
        note: "Uses only owner-supplied context.",
        risk_level: "low",
        next_step: "Review the wording, then publish when ready.",
      });
    },
  });
  return { handler, getProviderBody: () => providerBody };
}

test("first-win social draft is tenant-bound, business-type-aware, and needs no integration", async () => {
  const { handler, getProviderBody } = fixture();
  const response = await handler(request({
    business_id: BUSINESS_ID,
    task: "social_post",
    prompt: "Fall royal icing cookies available for seasonal orders.",
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.business_id, BUSINESS_ID);
  assert.equal(body.business_type, "bakery_food");
  assert.equal(body.task, "social_post");
  assert.equal(body.primary_text, "Fresh fall cookie designs are here.");

  const provider = getProviderBody();
  assert.equal(provider.store, false);
  assert.equal(provider.model, "test-model");
  const text = provider.input[0].content[0].text;
  assert.match(text, /Tierney Town Treats/);
  assert.match(text, /bakery or food business/);
  assert.match(text, /Fall royal icing cookies/);
  assert.doesNotMatch(JSON.stringify(body), /server-ai-key/);
});

test("first-win social post can use one owner-supplied photo without leaking it in the result", async () => {
  const { handler, getProviderBody } = fixture();
  const image = "data:image/png;base64,AA==";
  const response = await handler(request({
    business_id: BUSINESS_ID,
    task: "social_post",
    prompt: "Create a simple post for this product.",
    image_data_url: image,
  }));
  assert.equal(response.status, 200);
  const provider = getProviderBody();
  assert.equal(provider.input[0].content[1].type, "input_image");
  assert.equal(provider.input[0].content[1].image_url, image);
  assert.equal(JSON.stringify(await response.clone().json()).includes(image), false);
});

test("first-win customer reply is conservative and does not accept images", async () => {
  const { handler, getProviderBody } = fixture();
  const response = await handler(request({
    business_id: BUSINESS_ID,
    task: "customer_reply",
    prompt: "Can you make 30 cookies for Saturday and what will it cost?",
  }));
  assert.equal(response.status, 200);
  const provider = getProviderBody();
  assert.equal(provider.input[0].content.length, 1);
  assert.match(provider.input[0].content[0].text, /Do not invent price/);

  const invalidImage = await handler(request({
    business_id: BUSINESS_ID,
    task: "customer_reply",
    prompt: "Hello",
    image_data_url: "data:image/png;base64,AA==",
  }));
  assert.equal(invalidImage.status, 400);
});

test("first-win endpoint fails before AI for unauthenticated or locked workspaces", async () => {
  const unauthorized = fixture({ authorized: false });
  assert.equal((await unauthorized.handler(request({
    business_id: BUSINESS_ID,
    task: "social_post",
    prompt: "Post",
  }))).status, 401);
  assert.equal(unauthorized.getProviderBody(), null);

  const locked = createTenantFirstWinHandler({
    authorize: async (_request, { businessId }) => ({ ok: true, businessId }),
    tenantStore: {
      async readTenantProfile({ businessId }) {
        return { business_id: businessId, business_name: "Locked", business_type: "retail" };
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
    env: () => "should-not-be-used",
    fetchImpl: async () => { throw new Error("provider should not be called"); },
  });
  assert.equal((await locked(request({
    business_id: BUSINESS_ID,
    task: "social_post",
    prompt: "Post",
  }))).status, 403);
});

test("first-win endpoint validates task, context, and photo type", async () => {
  const { handler } = fixture();
  assert.equal((await handler(request({
    business_id: BUSINESS_ID,
    task: "unknown",
    prompt: "Hello",
  }))).status, 400);
  assert.equal((await handler(request({
    business_id: BUSINESS_ID,
    task: "social_post",
    prompt: "",
  }))).status, 400);
  assert.equal((await handler(request({
    business_id: BUSINESS_ID,
    task: "social_post",
    prompt: "Hello",
    image_data_url: "data:image/gif;base64,AA==",
  }))).status, 400);
});
