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

function clean(value, max = 2500) {
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

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    headline: { type: "string" },
    angle: { type: "string" },
    why_this_idea: { type: "string" },
    facebook_caption: { type: "string" },
    instagram_caption: { type: "string" },
    photo_note: { type: "string" },
  },
  required: ["headline","angle","why_this_idea","facebook_caption","instagram_caption","photo_note"],
};

export function createRetailProductPromotionHandler(options = {}) {
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name));
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function handler(request) {
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

    const product = body?.product || {};
    const facts = {
      item_name: clean(product.item_name, 220),
      variation_name: clean(product.variation_name, 120),
      description: clean(product.description, 1600),
      sku: clean(product.sku, 100),
      upc: clean(product.upc, 80),
      price: clean(product.price, 40),
      quantity: Number.isFinite(Number(product.quantity)) ? Number(product.quantity) : null,
      approved_promotion: clean(body?.approved_promotion, 700),
    };

    if (!facts.item_name) return json(400, { error: "Choose a product before building a promotion." });

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
            "You are GrowthWise for a small retail business. Build a practical social promotion for ONE existing inventory product. " +
            "Use only supplied product facts and any explicitly approved promotion. Do not invent discounts, scarcity, materials, fit, popularity, customer demand, sales history, or product features. " +
            "If inventory is low, do not create false urgency. If no product photo was supplied, simply recommend taking or selecting a clear current photo. " +
            "Facebook and Instagram copy should be natural, concise, and useful. Return only structured data.",
          input: [{
            role: "user",
            content: [{
              type: "input_text",
              text: "Create a reviewed promotion draft from this Square inventory record:\n\n" + JSON.stringify(facts),
            }],
          }],
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "growthwise_existing_product_promotion",
              strict: true,
              schema: SCHEMA,
            },
          },
        }),
      });
    } catch {
      return json(503, { error: "GrowthWise promotion AI is temporarily unavailable." });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(response.status, { error: String(data?.error?.message || data?.error || "Promotion AI request failed.") });
    }

    const text = extractOutputText(data);
    if (!text) return json(502, { error: "GrowthWise AI returned no promotion draft." });

    let result;
    try { result = JSON.parse(text); }
    catch { return json(502, { error: "GrowthWise AI returned an unreadable promotion draft." }); }

    return json(200, {
      ok: true,
      model,
      product: facts,
      headline: clean(result.headline, 220),
      angle: clean(result.angle, 500),
      why_this_idea: clean(result.why_this_idea, 700),
      facebook_caption: clean(result.facebook_caption, 2200),
      instagram_caption: clean(result.instagram_caption, 2200),
      photo_note: clean(result.photo_note, 500),
    });
  };
}

export default createRetailProductPromotionHandler();
