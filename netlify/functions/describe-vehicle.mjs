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

function clean(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
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

  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey = Netlify.env.get("OPENAI_API_KEY");
  const model = Netlify.env.get("OPENAI_AUTOMOTIVE_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";

  if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) return json(401, { error: "Invalid GrowthWise admin key." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const imageDataUrl = clean(body.image_data_url, 14_000_000);
  if (!imageDataUrl.startsWith("data:image/")) return json(400, { error: "A vehicle photo is required." });
  if (imageDataUrl.length > 14_000_000) return json(413, { error: "The vehicle photo is too large." });

  const year = clean(body.year, 10);
  const make = clean(body.make, 80);
  const vehicleModel = clean(body.model, 100);
  const trim = clean(body.trim, 100);
  const mileage = clean(body.mileage, 30);
  const vin = clean(body.vin, 40);
  const price = clean(body.price, 30);
  const notes = clean(body.notes, 1500);
  const businessName = clean(body.business_name, 120) || "the dealership";

  const supplied = [
    year && `Year: ${year}`,
    make && `Make: ${make}`,
    vehicleModel && `Model: ${vehicleModel}`,
    trim && `Trim: ${trim}`,
    mileage && `Mileage: ${mileage}`,
    vin && `VIN supplied by dealer: ${vin}`,
    price && `Asking price: $${price}`,
    notes && `Dealer notes: ${notes}`,
  ].filter(Boolean).join("\n") || "The dealer has not supplied vehicle details yet.";

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
        `You are GrowthWise, an automotive merchandising assistant for ${businessName}. ` +
        "Create accurate, useful used-vehicle marketing copy from dealer-supplied facts and the photo. " +
        "Treat dealer-entered year, make, model, trim, mileage, VIN and price as authoritative. " +
        "Never infer mechanical condition, accident history, title status, drivetrain, engine, trim, options, ownership history, warranty, inspection status, or service history unless the dealer supplied it. " +
        "A photo may support only directly visible facts such as body color, body style, wheel appearance, obvious exterior features, or visible cosmetic condition. " +
        "Do not hide or minimize visible damage. Do not claim a vehicle is clean, flawless, reliable, certified, accident-free, one-owner, or fully serviced unless supplied by the dealer. " +
        "Use natural dealership copy, not hype. Return only the requested structured data.",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Prepare a vehicle listing draft.\n\nDealer-supplied information:\n${supplied}\n\nUse dealer-supplied facts first and the image only for clearly visible details. If important details are missing, do not guess.`
          },
          { type: "input_image", image_url: imageDataUrl, detail: "high" },
        ],
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_vehicle_listing",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              listing_title: { type: "string" },
              description: { type: "string" },
              facebook_caption: { type: "string" },
              instagram_caption: { type: "string" },
              visible_features: { type: "array", items: { type: "string" } },
              missing_details: { type: "array", items: { type: "string" } },
              caution_note: { type: "string" }
            },
            required: ["listing_title", "description", "facebook_caption", "instagram_caption", "visible_features", "missing_details", "caution_note"]
          }
        }
      }
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = data?.error?.message || data?.error || `OpenAI request failed (HTTP ${response.status}).`;
    return json(response.status, { error: String(apiMessage) });
  }

  const outputText = extractOutputText(data);
  if (!outputText) return json(502, { error: "AI returned no vehicle listing." });

  let listing;
  try { listing = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable vehicle listing." }); }

  return json(200, {
    ok: true,
    model,
    listing_title: clean(listing.listing_title, 300),
    description: clean(listing.description, 4000),
    facebook_caption: clean(listing.facebook_caption, 5000),
    instagram_caption: clean(listing.instagram_caption, 3000),
    visible_features: Array.isArray(listing.visible_features) ? listing.visible_features.map(v => clean(v, 300)).filter(Boolean) : [],
    missing_details: Array.isArray(listing.missing_details) ? listing.missing_details.map(v => clean(v, 300)).filter(Boolean) : [],
    caution_note: clean(listing.caution_note, 1000),
  });
};
