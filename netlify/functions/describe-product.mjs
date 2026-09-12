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
      if (part?.type === "output_text" && typeof part.text === "string") {
        return part.text;
      }
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

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey = Netlify.env.get("OPENAI_API_KEY");
  const model = Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";

  if (!adminKey || !openaiKey) {
    return json(500, { error: "Server AI configuration is incomplete." });
  }

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) {
    return json(401, { error: "Invalid GrowthWise admin key." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const imageDataUrl = String(body.image_data_url || "");
  const brandHint = String(body.brand_hint || "").trim();
  const productNameHint = String(body.product_name_hint || "").trim();
  const price = String(body.price || "").trim();

  if (!imageDataUrl.startsWith("data:image/")) {
    return json(400, { error: "A product image is required." });
  }

  // Keep requests bounded. The client already uses phone-sized product photos.
  if (imageDataUrl.length > 14_000_000) {
    return json(413, { error: "The product image is too large. Please choose a smaller photo." });
  }

  const context = [
    brandHint ? `Brand supplied by the store owner: ${brandHint}` : "No brand was supplied by the store owner.",
    productNameHint ? `Product name supplied by the store owner: ${productNameHint}` : "No product name was supplied by the store owner.",
    price ? `Current price supplied by the store owner: $${price}` : "No price was supplied yet.",
  ].join("\n");

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "none" },
      instructions:
        "You are GrowthWise, a retail merchandising assistant for Dexter's Hats & Caps. " +
        "Analyze the product photo conservatively. Never invent a brand, material, model name, size, origin, or feature that is not clearly visible or supplied by the store owner. " +
        "If a brand is not legible, return an empty brand string. If the exact product/model name is unknown, suggest a clear descriptive retail name based only on visible appearance. " +
        "Write polished but natural retail copy. Do not claim limited stock, discounts, free shipping, guarantees, or other offers unless supplied. " +
        "The description should be useful in Square/website listings. The Facebook caption should sound inviting and include the price only if supplied. " +
        "Return only the requested structured data.",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Create a careful product listing draft from this photo.\n\n" +
                context +
                "\n\nUse visible details only. If uncertain, keep the wording generic rather than guessing.",
            },
            {
              type: "input_image",
              image_url: imageDataUrl,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_product_listing",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              brand: {
                type: "string",
                description: "Brand only when supplied or clearly legible in the image; otherwise empty string.",
              },
              product_name: {
                type: "string",
                description: "Supplied product name, or a concise descriptive retail name based on visible appearance.",
              },
              description: {
                type: "string",
                description: "Two or three concise sentences suitable for Square or a website listing, based only on visible/supplied facts.",
              },
              facebook_caption: {
                type: "string",
                description: "A polished Facebook post for Dexter's Hats & Caps. Include supplied price if available. No unsupported claims.",
              },
              visible_features: {
                type: "array",
                items: { type: "string" },
                description: "Short list of clearly visible product features.",
              },
              uncertainty_note: {
                type: "string",
                description: "Brief note about any important uncertainty, or empty string if none.",
              },
            },
            required: [
              "brand",
              "product_name",
              "description",
              "facebook_caption",
              "visible_features",
              "uncertainty_note",
            ],
          },
        },
      },
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const apiMessage =
      data?.error?.message ||
      data?.error ||
      `OpenAI request failed (HTTP ${response.status}).`;
    return json(response.status, { error: String(apiMessage) });
  }

  const outputText = extractOutputText(data);
  if (!outputText) {
    return json(502, { error: "AI returned no product description." });
  }

  let listing;
  try {
    listing = JSON.parse(outputText);
  } catch {
    return json(502, { error: "AI returned an unreadable product description." });
  }

  return json(200, {
    ok: true,
    model,
    brand: String(listing.brand || "").trim(),
    product_name: String(listing.product_name || "").trim(),
    description: String(listing.description || "").trim(),
    facebook_caption: String(listing.facebook_caption || "").trim(),
    visible_features: Array.isArray(listing.visible_features) ? listing.visible_features : [],
    uncertainty_note: String(listing.uncertainty_note || "").trim(),
  });
};
