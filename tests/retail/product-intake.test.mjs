import test from "node:test";
import assert from "node:assert/strict";

import {
  createProductIntakeHandler,
  normalizeProductIntake,
} from "../../netlify/functions/product-intake.mjs";

function openAiResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function structuredOutput(value) {
  return {
    output: [{
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    }],
  };
}

function request(body, key = "admin") {
  return new Request("https://growthwise.example/.netlify/functions/product-intake", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-growthwise-key": key,
    },
    body: JSON.stringify(body),
  });
}

test("product intake rejects requests without the GrowthWise key", async () => {
  const handler = createProductIntakeHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
      OPENAI_PRODUCT_MODEL: "test-model",
    }[name] || ""),
    fetchImpl: async () => { throw new Error("should not call provider"); },
  });

  const response = await handler(request({ image_data_url: "data:image/jpeg;base64,/9j/" }, "wrong"));
  assert.equal(response.status, 401);
});

test("product intake normalizes visible retail fields and keeps uncertainty explicit", async () => {
  let providerBody;
  const handler = createProductIntakeHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
      OPENAI_PRODUCT_MODEL: "test-model",
    }[name] || ""),
    fetchImpl: async (_url, init) => {
      providerBody = JSON.parse(init.body);
      return openAiResponse(structuredOutput({
        scan_type: "product_tag",
        summary: "One hat tag",
        products: [{
          brand: "Stacy Adams",
          product_name: "Dublin",
          style_sku: "DUB-42",
          upc: "123456789012",
          color: "Cognac",
          size: "L",
          material: "",
          price: "$79.95",
          price_type: "retail",
          quantity: "6",
          description: "Cognac porkpie hat.",
          confidence: "high",
          evidence: "Brand and price are printed on tag.",
          needs_confirmation: ["Material"],
        }],
        promotion: {
          headline: "Feature the Dublin",
          angle: "New arrival",
          why_this_idea: "The product details are clearly visible.",
          facebook_caption: "New arrival: Stacy Adams Dublin.",
          instagram_caption: "New arrival: Stacy Adams Dublin.",
        },
        uncertainty_notes: ["Material is not visible."],
      }));
    },
  });

  const response = await handler(request({
    mode: "tag",
    images: ["data:image/jpeg;base64,/9j/2Q=="],
  }));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.products[0].price, "79.95");
  assert.equal(body.products[0].quantity, "6");
  assert.equal(body.products[0].price_type, "retail");
  assert.deepEqual(body.products[0].needs_confirmation, ["Material"]);
  assert.equal(providerBody.store, false);
  assert.equal(providerBody.input[0].content.some((part) => part.type === "input_image"), true);
});

test("product intake preserves wholesale classification instead of treating order cost as retail", () => {
  const normalized = normalizeProductIntake({
    scan_type: "order_form",
    summary: "Order",
    products: [{
      brand: "Vendor",
      product_name: "Hat",
      style_sku: "A1",
      upc: "",
      color: "",
      size: "",
      material: "",
      price: "$32.50",
      price_type: "wholesale",
      quantity: "12",
      description: "",
      confidence: "medium",
      evidence: "Invoice line",
      needs_confirmation: [],
    }],
    promotion: {
      headline: "",
      angle: "",
      why_this_idea: "",
      facebook_caption: "",
      instagram_caption: "",
    },
    uncertainty_notes: [],
  });

  assert.equal(normalized.products[0].price, "32.50");
  assert.equal(normalized.products[0].price_type, "wholesale");
  assert.equal(normalized.products[0].quantity, "12");
});

test("product intake supports up to four scan images for multi-page order forms", async () => {
  let imageParts = 0;
  const handler = createProductIntakeHandler({
    env: (name) => ({
      GROWTHWISE_ADMIN_KEY: "admin",
      OPENAI_API_KEY: "key",
    }[name] || ""),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      imageParts = body.input[0].content.filter((part) => part.type === "input_image").length;
      return openAiResponse(structuredOutput({
        scan_type: "order_form",
        summary: "Two lines",
        products: [
          { brand:"A", product_name:"One", style_sku:"1", upc:"", color:"", size:"", material:"", price:"10", price_type:"wholesale", quantity:"2", description:"", confidence:"high", evidence:"line 1", needs_confirmation:[] },
          { brand:"B", product_name:"Two", style_sku:"2", upc:"", color:"", size:"", material:"", price:"20", price_type:"wholesale", quantity:"3", description:"", confidence:"high", evidence:"line 2", needs_confirmation:[] },
        ],
        promotion: { headline:"", angle:"", why_this_idea:"", facebook_caption:"", instagram_caption:"" },
        uncertainty_notes: [],
      }));
    },
  });

  const response = await handler(request({
    mode: "order_form",
    images: [
      "data:image/jpeg;base64,/9j/1",
      "data:image/jpeg;base64,/9j/2",
      "data:image/jpeg;base64,/9j/3",
      "data:image/jpeg;base64,/9j/4",
    ],
  }));
  assert.equal(response.status, 200);
  assert.equal(imageParts, 4);
});
