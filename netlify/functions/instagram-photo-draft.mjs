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

function extractOutputText(data) {
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
}

export default async (request) => {
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

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey = Netlify.env.get("OPENAI_API_KEY");
  const model = Netlify.env.get("OPENAI_MARKETING_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";

  if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });
  if ((request.headers.get("x-growthwise-key") || "") !== adminKey) {
    return json(401, { error: "Invalid GrowthWise access key." });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const imageDataUrl = String(body.image_data_url || "");
  if (!imageDataUrl.startsWith("data:image/")) {
    return json(400, { error: "A product image is required." });
  }
  if (imageDataUrl.length > 14_000_000) {
    return json(413, { error: "The product image is too large. Please choose a smaller photo." });
  }

  const response = await fetch(OPENAI_URL, {
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
        "You are GrowthWise, creating an Instagram post for Dexter's Hats & Caps. " +
        "Analyze ONE product photo conservatively. Never invent a brand, model, material, price, size, stock level, discount, rarity, event, or feature that is not clearly visible. " +
        "If exact product identity is uncertain, use generic visible wording such as 'classic fedora' or 'structured cap' instead of guessing. " +
        "Write a natural Instagram caption that sounds like a real independent hat store, not generic AI copy. " +
        "Do not mention Square, Facebook, AI, automation, or internal systems. " +
        "Do not claim a price or promotion unless one is visible in the image. " +
        "Use a small number of relevant hashtags, not hashtag spam. Return only structured data.",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Draft an Instagram-ready post from this product photo. Use only facts visible in the image. If something important is uncertain, make the caption safely generic rather than guessing."
          },
          {
            type: "input_image",
            image_url: imageDataUrl,
            detail: "high"
          }
        ]
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_instagram_photo_draft",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              product_label: { type: "string" },
              caption: { type: "string" },
              visible_features: { type: "array", items: { type: "string" } },
              uncertainty_note: { type: "string" }
            },
            required: ["product_label", "caption", "visible_features", "uncertainty_note"]
          }
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json(response.status, {
      error: String(data?.error?.message || data?.error || "Instagram draft request failed.")
    });
  }

  const text = extractOutputText(data);
  if (!text) return json(502, { error: "GrowthWise returned no Instagram draft." });

  let draft;
  try { draft = JSON.parse(text); }
  catch { return json(502, { error: "GrowthWise returned an unreadable Instagram draft." }); }

  return json(200, {
    ok: true,
    model,
    product_label: String(draft.product_label || "").trim(),
    caption: String(draft.caption || "").trim().slice(0, 2200),
    visible_features: Array.isArray(draft.visible_features) ? draft.visible_features.slice(0, 12) : [],
    uncertainty_note: String(draft.uncertainty_note || "").trim()
  });
};
