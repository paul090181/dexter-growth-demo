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

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function collectSourceUrls(data) {
  const urls = [];
  for (const item of data?.output || []) {
    if (item?.type !== "web_search_call") continue;
    for (const source of item?.action?.sources || []) {
      if (source?.url && !urls.includes(source.url)) urls.push(source.url);
    }
  }
  return urls.slice(0, 20);
}

function normalizeUrl(url) {
  const value = clean(url, 1200);
  if (!/^https?:\/\//i.test(value)) return "";
  return value;
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

  const retailMarket = clean(body.retail_market, 120) || "Buffalo, NY";
  const searchRadius = Math.min(500, Math.max(10, num(body.search_radius, 150)));
  const maxPurchase = Math.max(1000, num(body.max_purchase, 12000));
  const targetGross = Math.max(500, num(body.target_gross, 3000));
  const minYear = Math.max(1990, Math.min(2030, num(body.min_year, 2012)));
  const maxYear = Math.max(minYear, Math.min(2030, num(body.max_year, 2024)));
  const maxMileage = Math.max(10000, num(body.max_mileage, 140000));
  const vehicleTypes = clean(body.vehicle_types, 300) || "Any body style";
  const preferredMakes = clean(body.preferred_makes, 400) || "Any reliable mainstream make";
  const excludedMakes = clean(body.excluded_makes, 400);
  const notes = clean(body.notes, 1400);
  const maxResults = Math.min(6, Math.max(1, Math.round(num(body.max_results, 5))));

  const criteria = [
    `Retail market: ${retailMarket}`,
    `Search radius: about ${Math.round(searchRadius)} miles`,
    `Maximum acquisition price: $${Math.round(maxPurchase)}`,
    `Target gross profit per vehicle: $${Math.round(targetGross)}`,
    `Model years: ${Math.round(minYear)}-${Math.round(maxYear)}`,
    `Maximum mileage: ${Math.round(maxMileage)}`,
    `Preferred vehicle types: ${vehicleTypes}`,
    `Preferred makes: ${preferredMakes}`,
    excludedMakes && `Exclude makes: ${excludedMakes}`,
    notes && `Dealer preferences / notes: ${notes}`,
  ].filter(Boolean).join("\n");

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      include: ["web_search_call.action.sources"],
      reasoning: { effort: "low" },
      tools: [{
        type: "web_search",
        search_context_size: "high",
        user_location: {
          type: "approximate",
          city: retailMarket,
          country: "US"
        }
      }],
      instructions:
        "You are GrowthWise Vehicle Scout for a small independent dealership with an in-house repair shop. " +
        "Search CURRENT public vehicle listings and identify acquisition leads that could plausibly be resold profitably in the dealer's retail market. " +
        "Treat this as opportunity discovery, not a purchase recommendation. Use direct public listing evidence whenever possible. " +
        "Do not invent vehicles, prices, mileage, locations, VINs, listing URLs, title status, condition, accident history, repair needs, or completed-sale prices. " +
        "If an exact candidate does not have a visible asking price and enough identifying information, exclude it. " +
        "Estimate retail conservatively from current asking-price evidence, not guaranteed transaction values. " +
        "Estimate recon and internal labor as conservative allowances; do not infer hidden defects. " +
        "Prefer candidates where the asking price is at or below the dealer's budget and projected gross can meet the target after fees, transport, recon and labor. " +
        "If few strong candidates exist, return fewer results rather than weak or fabricated ones. Return only the requested structured data.",
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text:
            `Find up to ${maxResults} currently advertised vehicle acquisition opportunities that best match these dealer criteria:\n\n${criteria}\n\n` +
            "For each candidate, use the actual public listing asking price and mileage when shown. Estimate a realistic local retail midpoint and major acquisition allowances. " +
            "Give each candidate a 0-100 opportunity score that rewards margin, resale fit, evidence quality, reasonable mileage, and proximity. " +
            "Also provide a concise reason the vehicle may fit this dealership and the most important caveats to verify before buying."
        }]
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_vehicle_opportunity_search",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              search_summary: { type: "string" },
              confidence: { type: "string", enum: ["Low", "Medium", "High"] },
              opportunities: {
                type: "array",
                maxItems: 6,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    year: { type: "number" },
                    make: { type: "string" },
                    model: { type: "string" },
                    trim: { type: "string" },
                    source_type: { type: "string" },
                    listing_url: { type: "string" },
                    location: { type: "string" },
                    asking_price: { type: "number" },
                    mileage: { type: "number" },
                    retail_low: { type: "number" },
                    retail_mid: { type: "number" },
                    retail_high: { type: "number" },
                    estimated_fees: { type: "number" },
                    estimated_transport: { type: "number" },
                    estimated_recon: { type: "number" },
                    estimated_labor: { type: "number" },
                    score: { type: "number" },
                    evidence_quality: { type: "string", enum: ["Low", "Medium", "High"] },
                    why_fit: { type: "string" },
                    caveats: { type: "array", items: { type: "string" } }
                  },
                  required: [
                    "year", "make", "model", "trim", "source_type", "listing_url", "location",
                    "asking_price", "mileage", "retail_low", "retail_mid", "retail_high",
                    "estimated_fees", "estimated_transport", "estimated_recon", "estimated_labor",
                    "score", "evidence_quality", "why_fit", "caveats"
                  ]
                }
              }
            },
            required: ["search_summary", "confidence", "opportunities"]
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
  if (!outputText) return json(502, { error: "AI returned no vehicle opportunities." });

  let result;
  try { result = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable opportunity search." }); }

  const sourceUrls = collectSourceUrls(data);
  const sourceSet = new Set(sourceUrls);
  const opportunities = [];

  for (const raw of Array.isArray(result.opportunities) ? result.opportunities : []) {
    const ask = Math.max(0, num(raw.asking_price));
    const retailLow = Math.max(0, num(raw.retail_low));
    const retailMid = Math.max(retailLow, num(raw.retail_mid));
    const retailHigh = Math.max(retailMid, num(raw.retail_high));
    const fees = Math.max(0, num(raw.estimated_fees));
    const transport = Math.max(0, num(raw.estimated_transport));
    const recon = Math.max(0, num(raw.estimated_recon));
    const labor = Math.max(0, num(raw.estimated_labor));
    const allIn = ask + fees + transport + recon + labor;
    const projectedGross = retailMid - allIn;
    const roi = allIn > 0 ? (projectedGross / allIn) * 100 : 0;
    const maxBuy = Math.max(0, retailMid - fees - transport - recon - labor - targetGross);
    const rawUrl = normalizeUrl(raw.listing_url);
    const verifiedUrl = rawUrl && sourceSet.has(rawUrl) ? rawUrl : "";

    let recommendation = "WATCH";
    if (ask > 0 && projectedGross >= targetGross && roi >= 15 && ask <= maxPurchase) recommendation = "STRONG LEAD";
    else if (ask > maxPurchase || projectedGross < Math.max(1000, targetGross * 0.5) || roi < 5) recommendation = "PASS";

    opportunities.push({
      year: Math.round(num(raw.year)),
      make: clean(raw.make, 80),
      model: clean(raw.model, 100),
      trim: clean(raw.trim, 100),
      source_type: clean(raw.source_type, 80),
      listing_url: verifiedUrl,
      location: clean(raw.location, 160),
      asking_price: Math.round(ask),
      mileage: Math.round(Math.max(0, num(raw.mileage))),
      retail_low: Math.round(retailLow),
      retail_mid: Math.round(retailMid),
      retail_high: Math.round(retailHigh),
      estimated_fees: Math.round(fees),
      estimated_transport: Math.round(transport),
      estimated_recon: Math.round(recon),
      estimated_labor: Math.round(labor),
      projected_all_in: Math.round(allIn),
      projected_gross: Math.round(projectedGross),
      projected_roi: Math.round(roi * 10) / 10,
      recommended_max_buy: Math.round(maxBuy),
      score: Math.max(0, Math.min(100, Math.round(num(raw.score)))),
      evidence_quality: clean(raw.evidence_quality, 20) || "Low",
      recommendation,
      why_fit: clean(raw.why_fit, 800),
      caveats: Array.isArray(raw.caveats) ? raw.caveats.map(v => clean(v, 320)).filter(Boolean) : [],
    });
  }

  opportunities.sort((a, b) => b.score - a.score || b.projected_gross - a.projected_gross);

  return json(200, {
    ok: true,
    model,
    search_summary: clean(result.search_summary, 1600),
    confidence: clean(result.confidence, 20) || "Low",
    criteria: {
      retail_market: retailMarket,
      search_radius: Math.round(searchRadius),
      max_purchase: Math.round(maxPurchase),
      target_gross: Math.round(targetGross),
      min_year: Math.round(minYear),
      max_year: Math.round(maxYear),
      max_mileage: Math.round(maxMileage),
      vehicle_types: vehicleTypes,
      preferred_makes: preferredMakes,
    },
    opportunities,
    source_urls: sourceUrls,
    caution: "Opportunity search is preliminary. Verify listing availability, VIN, title, condition, fees, transport and repair needs before buying or bidding."
  });
};
