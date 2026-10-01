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

function clean(value, max = 5000) {
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

async function runStructured(openaiKey, model, instructions, userText, name, schema) {
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
      instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: userText }] }],
      text: {
        verbosity: "low",
        format: { type: "json_schema", name, strict: true, schema },
      },
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const apiMessage = data?.error?.message || data?.error || `OpenAI request failed (HTTP ${response.status}).`;
    throw new Error(String(apiMessage));
  }
  const outputText = extractOutputText(data);
  if (!outputText) throw new Error("AI returned no usable result.");
  try { return JSON.parse(outputText); }
  catch { throw new Error("AI returned an unreadable result."); }
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
  const model = Netlify.env.get("OPENAI_MARKETING_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
  if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) return json(401, { error: "Invalid GrowthWise admin key." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const businessName = clean(body.business_name, 120) || "the dealership";
  const businessPhone = clean(body.business_phone, 80);
  const businessWebsite = clean(body.business_website, 240);
  const retailMarket = clean(body.retail_market, 120) || "Buffalo, NY";
  const vehicle = clean(body.vehicle, 220);
  const mileage = clean(body.mileage, 40);
  const askingPrice = clean(body.asking_price, 40);
  const daysOnLot = clean(body.days_on_lot, 30);
  const views = clean(body.views, 30);
  const leads = clean(body.leads, 30);
  const priceChanges = clean(body.price_changes, 400);
  const knownFacts = clean(body.known_facts, 2000);
  const campaignGoal = clean(body.campaign_goal, 120) || "move_inventory";

  if (!vehicle) return json(400, { error: "Enter a vehicle before creating a marketing plan." });

  const facts = [
    `Business: ${businessName}`,
    businessPhone && `Phone: ${businessPhone}`,
    businessWebsite && `Website: ${businessWebsite}`,
    `Retail market: ${retailMarket}`,
    `Vehicle: ${vehicle}`,
    mileage && `Mileage: ${mileage}`,
    askingPrice && `Current asking price: ${askingPrice}`,
    daysOnLot && `Days in inventory: ${daysOnLot}`,
    views && `Listing views/engagement count: ${views}`,
    leads && `Known leads/inquiries: ${leads}`,
    priceChanges && `Known pricing history: ${priceChanges}`,
    knownFacts && `Known vehicle/marketing facts: ${knownFacts}`,
    `Campaign goal: ${campaignGoal}`,
  ].filter(Boolean).join("\n");

  try {
    const result = await runStructured(
      openaiKey,
      model,
      `You are GrowthWise Automotive's inventory-turn marketing strategist for ${businessName}. ` +
      "Your job is to help the dealership sell owned inventory faster without inventing vehicle facts, discounts, market statistics, or performance data. " +
      "Use only supplied facts. If days-on-lot, views, leads, pricing history, local comps, or market data are missing, state that the recommendation is preliminary. " +
      "Do not automatically recommend a price cut. Prefer the least margin-destructive action likely to improve the chance of sale: better photos, stronger merchandising, refreshed listing copy, wider promotion, lead follow-up, a time-limited dealer-approved offer, or price review. " +
      "If recommending a price review, provide a strategy rather than inventing a precise market-derived price unless enough pricing evidence was supplied. " +
      "Never conceal damage or alter photos in a way that misrepresents condition. Photo suggestions may improve lighting, angle, framing, background cleanliness, and coverage only. " +
      "Create natural customer-facing copy for Facebook/Instagram and a short marketplace headline. If customer-specific lead follow-up was not supplied, do not invent a customer. " +
      "Return only structured data.",
      `Create a Move This Vehicle plan from these facts:\n\n${facts}`,
      "growthwise_move_vehicle_plan",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          priority: { type: "string", enum: ["low", "medium", "high", "urgent"] },
          recommended_action: { type: "string", enum: ["hold_and_promote", "refresh_listing", "refresh_photos", "expand_distribution", "follow_up_leads", "review_price", "bundle_offer", "mixed_plan"] },
          action_label: { type: "string" },
          reasoning: { type: "string" },
          margin_protection_note: { type: "string" },
          price_strategy: { type: "string" },
          photo_plan: { type: "array", items: { type: "string" }, maxItems: 6 },
          listing_headline: { type: "string" },
          facebook_caption: { type: "string" },
          instagram_caption: { type: "string" },
          staff_next_steps: { type: "array", items: { type: "string" }, maxItems: 6 },
          followup_window_days: { type: "integer", minimum: 1, maximum: 30 },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          missing_data: { type: "array", items: { type: "string" }, maxItems: 8 }
        },
        required: ["priority","recommended_action","action_label","reasoning","margin_protection_note","price_strategy","photo_plan","listing_headline","facebook_caption","instagram_caption","staff_next_steps","followup_window_days","confidence","missing_data"]
      }
    );

    return json(200, {
      ok: true,
      model,
      priority: clean(result.priority, 20) || "medium",
      recommended_action: clean(result.recommended_action, 60) || "mixed_plan",
      action_label: clean(result.action_label, 200),
      reasoning: clean(result.reasoning, 2500),
      margin_protection_note: clean(result.margin_protection_note, 1500),
      price_strategy: clean(result.price_strategy, 1500),
      photo_plan: Array.isArray(result.photo_plan) ? result.photo_plan.map(x => clean(x, 300)).filter(Boolean).slice(0,6) : [],
      listing_headline: clean(result.listing_headline, 300),
      facebook_caption: clean(result.facebook_caption, 3000),
      instagram_caption: clean(result.instagram_caption, 3000),
      staff_next_steps: Array.isArray(result.staff_next_steps) ? result.staff_next_steps.map(x => clean(x, 400)).filter(Boolean).slice(0,6) : [],
      followup_window_days: Math.max(1, Math.min(30, Number(result.followup_window_days) || 7)),
      confidence: clean(result.confidence, 20) || "low",
      missing_data: Array.isArray(result.missing_data) ? result.missing_data.map(x => clean(x, 300)).filter(Boolean).slice(0,8) : [],
    });
  } catch (err) {
    return json(502, { error: err?.message || "Marketing AI request failed." });
  }
};
