import test from "node:test";
import assert from "node:assert/strict";

import { createRetailOpportunitiesHandler } from "../../netlify/functions/retail-opportunities.mjs";

function providerResponse(value) {
  return new Response(JSON.stringify({
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function request(body, key = "admin") {
  return new Request("https://growthwise.example/.netlify/functions/retail-opportunities", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-key": key,
    },
    body: JSON.stringify(body),
  });
}

const snapshot = {
  inventory: [
    { item_name: "Dublin", price: "79.95", quantity: 5, sku: "DUB" },
    { item_name: "Fedora", price: "99.95", quantity: 1, sku: "FED" },
  ],
  sales_summary: { completed_order_count: 1, total_collected: "79.95", average_order: "79.95" },
  top_products: [{ item_name: "Dublin", quantity_sold: 1, total_collected: "79.95" }],
  known_promotions: "Tuesday: free accessory with $100+ purchase.",
};

test("retail opportunities require authenticated live inventory", async () => {
  const handler = createRetailOpportunitiesHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
    }[name] || ""),
    fetchImpl: async () => { throw new Error("no"); },
  });
  assert.equal((await handler(request(snapshot, "wrong"))).status, 401);
  assert.equal((await handler(request({ inventory: [] }))).status, 400);
});

test("retail opportunities return exactly three structured AI actions grounded in supplied data", async () => {
  let providerBody;
  const handler = createRetailOpportunitiesHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
      OPENAI_MARKETING_MODEL: "test-model",
    }[name] || ""),
    fetchImpl: async (_url, init) => {
      providerBody = JSON.parse(init.body);
      return providerResponse({
        summary: "Three ideas from current Square data.",
        suggestions: [
          { kind:"repeat_winner", title:"Feature Dublin", reason:"Dublin sold recently and 5 remain in stock.", product_name:"Dublin", action_label:"Build post", offer:"", facebook_caption:"Feature Dublin.", instagram_caption:"Feature Dublin.", confidence:"high" },
          { kind:"protect_stock", title:"Do not push Fedora", reason:"Only 1 Fedora is currently in stock.", product_name:"Fedora", action_label:"Review stock", offer:"", facebook_caption:"", instagram_caption:"", confidence:"high" },
          { kind:"traffic_driver", title:"Use Tuesday offer", reason:"The approved Tuesday offer can support a higher ticket.", product_name:"", action_label:"Build Tuesday post", offer:"Free accessory with $100+ purchase.", facebook_caption:"Tuesday offer.", instagram_caption:"Tuesday offer.", confidence:"medium" },
        ],
      });
    },
  });

  const response = await handler(request(snapshot));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.suggestions.length, 3);
  assert.match(body.suggestions[0].reason, /5 remain/);
  assert.equal(providerBody.store, false);
  assert.match(providerBody.input[0].content[0].text, /Dublin/);
  assert.match(providerBody.input[0].content[0].text, /Tuesday/);
});
