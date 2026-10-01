const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 14_000_000;
const MAX_PRODUCTS = 20;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function extractOutputText(data) {
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

function moneyText(value) {
  const raw = clean(value, 40).replaceAll(",", "").replace(/^\$/u, "");
  if (!raw) return "";
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number.toFixed(2) : "";
}

function quantityText(value) {
  const raw = clean(value, 30);
  if (!/^\d+$/u.test(raw)) return "";
  const number = Number(raw);
  return Number.isSafeInteger(number) && number >= 0 ? String(number) : "";
}

function imageList(body) {
  const raw = Array.isArray(body?.images) ? body.images : [body?.image_data_url].filter(Boolean);
  if (!raw.length || raw.length > MAX_IMAGES) throw new Error("IMAGE_COUNT");
  return raw.map((value) => {
    const image = String(value || "");
    if (!image.startsWith("data:image/") || image.length > MAX_IMAGE_CHARS) throw new Error("INVALID_IMAGE");
    return image;
  });
}

const PRODUCT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    scan_type: {
      type: "string",
      enum: ["product_photo", "product_tag", "order_form", "mixed"],
    },
    summary: { type: "string" },
    products: {
      type: "array",
      maxItems: MAX_PRODUCTS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          brand: { type: "string" },
          product_name: { type: "string" },
          style_sku: { type: "string" },
          upc: { type: "string" },
          color: { type: "string" },
          size: { type: "string" },
          material: { type: "string" },
          price: { type: "string" },
          price_type: { type: "string", enum: ["retail", "wholesale", "unknown"] },
          quantity: { type: "string" },
          description: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
          needs_confirmation: {
            type: "array",
            items: { type: "string" },
            maxItems: 8,
          },
        },
        required: [
          "brand", "product_name", "style_sku", "upc", "color", "size", "material",
          "price", "price_type", "quantity", "description", "confidence", "evidence",
          "needs_confirmation",
        ],
      },
    },
    promotion: {
      type: "object",
      additionalProperties: false,
      properties: {
        headline: { type: "string" },
        angle: { type: "string" },
        why_this_idea: { type: "string" },
        facebook_caption: { type: "string" },
        instagram_caption: { type: "string" },
      },
      required: ["headline", "angle", "why_this_idea", "facebook_caption", "instagram_caption"],
    },
    uncertainty_notes: {
      type: "array",
      items: { type: "string" },
      maxItems: 12,
    },
  },
  required: ["scan_type", "summary", "products", "promotion", "uncertainty_notes"],
};

export function normalizeProductIntake(result) {
  const products = Array.isArray(result?.products) ? result.products.slice(0, MAX_PRODUCTS) : [];
  return {
    scan_type: ["product_photo", "product_tag", "order_form", "mixed"].includes(result?.scan_type)
      ? result.scan_type : "mixed",
    summary: clean(result?.summary, 1000),
    products: products.map((product) => ({
      brand: clean(product?.brand, 120),
      product_name: clean(product?.product_name, 220),
      style_sku: clean(product?.style_sku, 120),
      upc: clean(product?.upc, 80),
      color: clean(product?.color, 100),
      size: clean(product?.size, 100),
      material: clean(product?.material, 180),
      price: moneyText(product?.price),
      price_type: ["retail", "wholesale", "unknown"].includes(product?.price_type)
        ? product.price_type : "unknown",
      quantity: quantityText(product?.quantity),
      description: clean(product?.description, 1600),
      confidence: ["high", "medium", "low"].includes(product?.confidence)
        ? product.confidence : "low",
      evidence: clean(product?.evidence, 1200),
      needs_confirmation: Array.isArray(product?.needs_confirmation)
        ? product.needs_confirmation.map((x) => clean(x, 180)).filter(Boolean).slice(0, 8)
        : [],
    })),
    promotion: {
      headline: clean(result?.promotion?.headline, 220),
      angle: clean(result?.promotion?.angle, 400),
      why_this_idea: clean(result?.promotion?.why_this_idea, 600),
      facebook_caption: clean(result?.promotion?.facebook_caption, 2200),
      instagram_caption: clean(result?.promotion?.instagram_caption, 1800),
    },
    uncertainty_notes: Array.isArray(result?.uncertainty_notes)
      ? result.uncertainty_notes.map((x) => clean(x, 250)).filter(Boolean).slice(0, 12)
      : [],
  };
}

export function createProductIntakeHandler(options = {}) {
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name));
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function productIntake(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key",
        },
      });
    }
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    const adminKey = env("GROWTHWISE_ADMIN_KEY");
    const openaiKey = env("OPENAI_API_KEY");
    const model = env("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
    if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });
    if ((request.headers.get("x-growthwise-key") || "") !== adminKey) {
      return json(401, { error: "Invalid GrowthWise access key." });
    }

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid JSON body." }); }

    let images;
    try { images = imageList(body); }
    catch (error) {
      return json(error?.message === "IMAGE_COUNT" ? 400 : 413, {
        error: error?.message === "IMAGE_COUNT"
          ? "Add between 1 and 4 photos to scan."
          : "One of the scan images is invalid or too large.",
      });
    }

    const mode = ["auto", "product", "tag", "order_form"].includes(body?.mode) ? body.mode : "auto";
    const userContext = clean(body?.context, 1200);

    const content = [{
      type: "input_text",
      text:
        "Read these retail product/tag/order-form images and prepare a no-typing GrowthWise intake draft.\n" +
        `Requested scan mode: ${mode}.\n` +
        (userContext ? `Store-supplied context: ${userContext}\n` : "") +
        "\nRules:\n" +
        "- Extract text conservatively. Never invent a brand, SKU, UPC, size, color, quantity, price, material, or model.\n" +
        "- When multiple images are product/tag/barcode/package views of the SAME physical product, merge evidence across all images into ONE product record. Do not create duplicate products merely because the same item appears in several photos.\n" +
        "- Treat camera/photo packets as one product unless the images clearly show different products or the requested mode is order_form.\n" +
        "- A price on an invoice/order form is usually wholesale/cost unless the document clearly labels it retail/MSRP. Mark price_type accordingly.\n" +
        "- If an exact product name is not printed, a photo may receive a plain descriptive retail name, but do not pretend it is an exact vendor model.\n" +
        "- For order forms, return every clearly legible line item up to 20.\n" +
        "- Put uncertain fields in needs_confirmation instead of guessing.\n" +
        "- Also create one conservative promotional idea for the first product using only visible/extracted facts. Do not invent discounts, scarcity, or availability.\n" +
        "- Facebook and Instagram copy should be natural and concise. If retail price is not clearly known, omit price from promotional copy.",
    }];
    for (const image of images) {
      content.push({ type: "input_image", image_url: image, detail: "high" });
    }

    let response;
    try {
      response = await fetchImpl(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning: { effort: "none" },
          instructions:
            "You are GrowthWise Intake AI for a retail business. Your job is to minimize typing by accurately reading product photos, tags, labels, invoices, and order forms. " +
            "Accuracy is more important than completeness. Never infer missing transactional facts. Return only structured data.",
          input: [{ role: "user", content }],
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "growthwise_product_intake",
              strict: true,
              schema: PRODUCT_SCHEMA,
            },
          },
        }),
      });
    } catch {
      return json(503, { error: "GrowthWise Intake AI is temporarily unavailable." });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.error || `AI intake failed (HTTP ${response.status}).`;
      return json(response.status, { error: String(message) });
    }

    const outputText = extractOutputText(data);
    if (!outputText) return json(502, { error: "AI returned no product intake result." });

    let result;
    try { result = JSON.parse(outputText); }
    catch { return json(502, { error: "AI returned an unreadable product intake result." }); }

    const normalized = normalizeProductIntake(result);
    if (!normalized.products.length) {
      return json(422, {
        error: "GrowthWise could not confidently identify a product or order-form line. Try a closer, clearer photo.",
        ...normalized,
      });
    }

    return json(200, { ok: true, model, ...normalized });
  };
}

export default createProductIntakeHandler();
