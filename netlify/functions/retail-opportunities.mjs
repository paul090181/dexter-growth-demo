const OPENAI_URL = "https://api.openai.com/v1/responses";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clean(value, max = 3000) {
  return String(value ?? "").trim().slice(0, max);
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

function compactInventory(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 80).map((item) => ({
    name: clean(item?.item_name, 180),
    variation: clean(item?.variation_name, 100),
    price: clean(item?.price, 30),
    quantity: Number.isFinite(Number(item?.quantity)) ? Number(item.quantity) : 0,
    sku: clean(item?.sku, 80),
  }));
}

function compactSales(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 30).map((item) => ({
    name: clean(item?.item_name, 180),
    variation: clean(item?.variation_name, 100),
    quantity_sold: Number.isFinite(Number(item?.quantity_sold)) ? Number(item.quantity_sold) : 0,
    total_collected: clean(item?.total_collected, 30),
  }));
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    suggestions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["promote", "protect_stock", "bundle", "repeat_winner", "improve_listing", "traffic_driver"] },
          title: { type: "string" },
          reason: { type: "string" },
          product_name: { type: "string" },
          action_label: { type: "string" },
          offer: { type: "string" },
          facebook_caption: { type: "string" },
          instagram_caption: { type: "string" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
        },
        required: [
          "kind", "title", "reason", "product_name", "action_label", "offer",
          "facebook_caption", "instagram_caption", "confidence",
        ],
      },
    },
  },
  required: ["summary", "suggestions"],
};

export function createRetailOpportunitiesHandler(options = {}) {
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name));
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function retailOpportunities(request) {
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
    const model = env("OPENAI_MARKETING_MODEL") || env("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
    if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });
    if ((request.headers.get("x-growthwise-key") || "") !== adminKey) {
      return json(401, { error: "Invalid GrowthWise access key." });
    }

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid JSON body." }); }

    const inventory = compactInventory(body?.inventory);
    const topProducts = compactSales(body?.top_products);
    const salesSummary = {
      completed_orders: Number(body?.sales_summary?.completed_order_count || 0),
      total_collected: clean(body?.sales_summary?.total_collected, 30),
      average_order: clean(body?.sales_summary?.average_order, 30),
    };
    const businessName = clean(body?.business_name, 120) || "Dexter's Hats & Caps";
    const day = clean(body?.day, 30) || "today";
    const knownPromotions = clean(body?.known_promotions, 1200);

    if (!inventory.length) return json(400, { error: "Live inventory is required for AI opportunities." });

    const facts = JSON.stringify({
      business_name: businessName,
      day,
      inventory,
      sales_summary: salesSummary,
      recent_top_products: topProducts,
      known_promotions: knownPromotions,
    });

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
            "You are GrowthWise, a practical retail growth assistant. Use ONLY the supplied inventory, recent sales, and known promotions. " +
            "Return exactly three distinct actions the owner can take today. Favor useful, low-friction opportunities: promote an in-stock item, repeat a recent winner when stock supports it, protect low stock rather than over-promote it, improve a weak listing, or use an already-approved promotion. " +
            "Never invent margins, costs, customer demographics, discounts, events, stock urgency, or sales trends. Do not recommend discounting unless an approved promotion was supplied. " +
            "Explain why each idea was suggested in one short sentence using the actual data. Customer-facing captions must not claim scarcity unless quantity is explicitly low and the wording remains factual. Return only structured data.",
          input: [{
            role: "user",
            content: [{
              type: "input_text",
              text:
                "Create the three best GrowthWise suggestions for the business owner from this current business snapshot.\n\n" +
                facts,
            }],
          }],
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "growthwise_retail_opportunities",
              strict: true,
              schema: SCHEMA,
            },
          },
        }),
      });
    } catch {
      return json(503, { error: "GrowthWise AI suggestions are temporarily unavailable." });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.error || `AI suggestion request failed (HTTP ${response.status}).`;
      return json(response.status, { error: String(message) });
    }

    const outputText = extractOutputText(data);
    if (!outputText) return json(502, { error: "AI returned no suggestions." });

    let result;
    try { result = JSON.parse(outputText); }
    catch { return json(502, { error: "AI returned unreadable suggestions." }); }

    const suggestions = Array.isArray(result?.suggestions) ? result.suggestions.slice(0, 3).map((item) => ({
      kind: clean(item?.kind, 40),
      title: clean(item?.title, 220),
      reason: clean(item?.reason, 500),
      product_name: clean(item?.product_name, 220),
      action_label: clean(item?.action_label, 80) || "Build post",
      offer: clean(item?.offer, 500),
      facebook_caption: clean(item?.facebook_caption, 2200),
      instagram_caption: clean(item?.instagram_caption, 1800),
      confidence: ["high", "medium", "low"].includes(item?.confidence) ? item.confidence : "low",
    })) : [];

    if (suggestions.length !== 3) return json(502, { error: "AI did not return three usable suggestions." });

    return json(200, {
      ok: true,
      model,
      summary: clean(result?.summary, 800),
      suggestions,
    });
  };
}

export default createRetailOpportunitiesHandler();
