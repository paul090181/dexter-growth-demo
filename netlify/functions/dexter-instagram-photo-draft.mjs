import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const BUSINESS_ID = "dexters-hats";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
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

export function createDexterInstagramPhotoDraftHandler({
  connectorStore = createConnectorStore(),
  connectorAuthorize = authorizeConnectorRequest,
  fetchImpl = fetch,
  env = (name) => globalThis.Netlify?.env?.get(name),
} = {}) {
  return async function dexterInstagramPhotoDraft(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    const auth = await connectorAuthorize(request, {
      store: connectorStore,
      businessId: BUSINESS_ID,
      connector: "instagram",
      now: new Date(),
    });
    if (!auth?.ok || auth.businessId !== BUSINESS_ID) {
      return json(401, { error: "Dexter pilot session is invalid or expired." });
    }

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid request." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || typeof body.image_data_url !== "string") {
      return json(400, { error: "A product image is required." });
    }
    const imageDataUrl = body.image_data_url;
    if (!/^data:image\/(?:png|jpeg);base64,/.test(imageDataUrl)) {
      return json(400, { error: "Choose a JPG or PNG product photo." });
    }
    if (imageDataUrl.length > 14_000_000) {
      return json(413, { error: "The product image is too large. Please choose a smaller photo." });
    }

    const openaiKey = env("OPENAI_API_KEY");
    const model = env("OPENAI_MARKETING_MODEL") || env("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
    if (!openaiKey) return json(503, { error: "GrowthWise AI is temporarily unavailable." });

    const response = await fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        reasoning: { effort: "none" },
        instructions:
          "You are GrowthWise, creating an Instagram post for Dexter's Hats & Caps. " +
          "Analyze ONE product photo conservatively. Never invent a brand, model, material, price, size, stock level, discount, rarity, event, or feature that is not clearly visible. " +
          "If exact product identity is uncertain, use generic visible wording instead of guessing. " +
          "Write a natural Instagram caption that sounds like a real independent hat store. " +
          "Do not mention Square, Facebook, AI, automation, or internal systems. " +
          "Do not claim a price or promotion unless one is visible in the image. " +
          "Use a small number of relevant hashtags. Return only structured data.",
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: "Draft an Instagram-ready post from this product photo. Use only facts visible in the image." },
            { type: "input_image", image_url: imageDataUrl, detail: "high" },
          ],
        }],
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "growthwise_dexter_pilot_instagram_draft",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                product_label: { type: "string" },
                caption: { type: "string" },
                uncertainty_note: { type: "string" },
              },
              required: ["product_label", "caption", "uncertainty_note"],
            },
          },
        },
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json(502, { error: "GrowthWise could not create the Instagram draft." });
    const output = extractOutputText(data);
    let result;
    try { result = JSON.parse(output); }
    catch { return json(502, { error: "GrowthWise returned an unreadable Instagram draft." }); }

    return json(200, {
      ok: true,
      product_label: String(result.product_label || "").trim(),
      caption: String(result.caption || "").trim().slice(0, 2200),
      uncertainty_note: String(result.uncertainty_note || "").trim(),
    });
  };
}

export default createDexterInstagramPhotoDraftHandler();
