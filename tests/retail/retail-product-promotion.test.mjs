import test from "node:test";
import assert from "node:assert/strict";

import { createRetailProductPromotionHandler } from "../../netlify/functions/retail-product-promotion.mjs";

function request(body, key = "admin") {
  return new Request("https://growthwise.example/.netlify/functions/retail-product-promotion", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-key": key,
    },
    body: JSON.stringify(body),
  });
}

function providerResponse(value) {
  return new Response(JSON.stringify({
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

test("selected product promotion requires authenticated product data", async () => {
  const handler = createRetailProductPromotionHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
    }[name] || ""),
    fetchImpl: async () => { throw new Error("should not call provider"); },
  });

  assert.equal((await handler(request({ product: { item_name: "Hat" } }, "wrong"))).status, 401);
  assert.equal((await handler(request({ product: {} }))).status, 400);
});

test("selected product promotion is grounded in the chosen Square record and approved offer", async () => {
  let providerBody;
  const handler = createRetailProductPromotionHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
      OPENAI_MARKETING_MODEL: "test-model",
    }[name] || ""),
    fetchImpl: async (_url, init) => {
      providerBody = JSON.parse(init.body);
      return providerResponse({
        headline: "Feature the Dublin",
        angle: "Product spotlight",
        why_this_idea: "The item is currently in stock.",
        facebook_caption: "Now available: Stacy Adams Dublin.",
        instagram_caption: "Stacy Adams Dublin now available.",
        photo_note: "Use a clear current product photo.",
      });
    },
  });

  const response = await handler(request({
    product: {
      item_name: "Stacy Adams Dublin",
      variation_name: "Cognac / L",
      price: "79.95",
      quantity: 5,
      sku: "DUB-42",
      description: "Porkpie hat.",
    },
    approved_promotion: "Tuesday: Free accessory with a purchase of $100 or more.",
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.headline, "Feature the Dublin");
  assert.equal(body.product.item_name, "Stacy Adams Dublin");
  assert.equal(body.product.quantity, 5);
  assert.equal(providerBody.store, false);
  const text = providerBody.input[0].content[0].text;
  assert.match(text, /Stacy Adams Dublin/);
  assert.match(text, /Free accessory/);
});
