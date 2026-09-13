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
  return urls.slice(0, 8);
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

  const year = clean(body.year, 10);
  const make = clean(body.make, 80);
  const vehicleModel = clean(body.model, 100);
  const trim = clean(body.trim, 100);
  const mileage = clean(body.mileage, 30);
  const vin = clean(body.vin, 40);
  const notes = clean(body.notes, 1800);
  const sourceType = clean(body.source_type, 80) || "unspecified source";
  const sourceLocation = clean(body.source_location, 120);
  const marketLocation = clean(body.market_location, 120) || "Buffalo, NY";
  const sourceUrl = clean(body.source_url, 1000);
  const currentAsk = Math.max(0, num(body.current_ask, 0));
  const targetGross = Math.max(0, num(body.target_gross, 3500));
  const imageDataUrl = clean(body.image_data_url, 14_000_000);

  if (!year || !make || !vehicleModel) {
    return json(400, { error: "Year, make, and model are required for market research." });
  }

  const facts = [
    `Vehicle: ${year} ${make} ${vehicleModel}${trim ? ` ${trim}` : ""}`,
    mileage && `Mileage: ${mileage}`,
    vin && `VIN supplied by dealer: ${vin}`,
    notes && `Dealer notes: ${notes}`,
    `Source type: ${sourceType}`,
    sourceLocation && `Vehicle/source location: ${sourceLocation}`,
    `Retail market: ${marketLocation}`,
    currentAsk > 0 && `Current ask/bid: $${Math.round(currentAsk)}`,
    sourceUrl && `Source/listing URL: ${sourceUrl}`,
    `Dealer target gross profit: $${Math.round(targetGross)}`,
  ].filter(Boolean).join("\n");

  const content = [{
    type: "input_text",
    text:
      `Research the current public market for this used vehicle and estimate the deal inputs a small independent dealer/mechanic shop would need.\n\n${facts}\n\n` +
      "Search current public vehicle listings and other relevant public sources. Prioritize comparable year/make/model/trim and similar mileage, using the retail market named above; broaden geographically only when local evidence is thin. " +
      "Treat public listing prices as asking prices, not guaranteed transaction values. Estimate a realistic retail asking range and midpoint. " +
      "Estimate buyer/auction fees based on the source type; if the exact platform is unknown, use a conservative allowance and say so. " +
      "Estimate transport only when source location is known; otherwise use 0 and explicitly flag it as unknown. " +
      "Estimate reconditioning and internal labor as allowances based only on dealer notes and clearly visible photo condition; never infer hidden mechanical defects. " +
      "Do not claim title history, accident history, mechanical condition, warranty, or options unless supplied. Prefer ranges and conservative assumptions over false precision."
  }];

  if (imageDataUrl.startsWith("data:image/")) {
    content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
  }

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
        search_context_size: "medium",
        user_location: {
          type: "approximate",
          city: marketLocation,
          country: "US"
        }
      }],
      instructions:
        "You are GrowthWise Vehicle Scout, an automotive sourcing and deal-analysis assistant. " +
        "Use live web research to estimate current retail-market evidence, then provide conservative numeric allowances for a dealer to review. " +
        "Never present estimates as guaranteed values. Never fabricate auction fee schedules, transport quotes, vehicle condition, title status, repair needs, or completed sales. " +
        "If evidence is weak, widen ranges and lower confidence. Return only the requested structured data.",
      input: [{ role: "user", content }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_vehicle_deal_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              market_summary: { type: "string" },
              retail_low: { type: "number" },
              retail_mid: { type: "number" },
              retail_high: { type: "number" },
              estimated_fees: { type: "number" },
              estimated_transport: { type: "number" },
              estimated_recon: { type: "number" },
              estimated_labor: { type: "number" },
              confidence: { type: "string", enum: ["Low", "Medium", "High"] },
              assumptions: { type: "array", items: { type: "string" } },
              evidence_notes: { type: "array", items: { type: "string" } }
            },
            required: [
              "market_summary", "retail_low", "retail_mid", "retail_high",
              "estimated_fees", "estimated_transport", "estimated_recon", "estimated_labor",
              "confidence", "assumptions", "evidence_notes"
            ]
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
  if (!outputText) return json(502, { error: "AI returned no deal analysis." });

  let analysis;
  try { analysis = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable deal analysis." }); }

  const retailLow = Math.max(0, num(analysis.retail_low));
  const retailMid = Math.max(retailLow, num(analysis.retail_mid));
  const retailHigh = Math.max(retailMid, num(analysis.retail_high));
  const fees = Math.max(0, num(analysis.estimated_fees));
  const transport = Math.max(0, num(analysis.estimated_transport));
  const recon = Math.max(0, num(analysis.estimated_recon));
  const labor = Math.max(0, num(analysis.estimated_labor));
  const nonAcquisition = fees + transport + recon + labor;
  const recommendedPurchase = Math.max(0, retailMid - nonAcquisition - targetGross);
  const acquisitionForProjection = currentAsk > 0 ? currentAsk : recommendedPurchase;
  const projectedAllIn = acquisitionForProjection + nonAcquisition;
  const projectedGross = retailMid - projectedAllIn;
  const projectedRoi = projectedAllIn > 0 ? (projectedGross / projectedAllIn) * 100 : 0;

  let decision = "MAYBE";
  if (currentAsk <= 0) {
    decision = "PRICE NEEDED";
  } else if (retailMid <= 0) {
    decision = "MAYBE";
  } else if (currentAsk > recommendedPurchase) {
    decision = "PASS";
  } else if (projectedGross >= targetGross && projectedRoi >= 15) {
    decision = analysis.confidence === "Low" ? "MAYBE" : "BUY";
  } else if (projectedGross < Math.max(1000, targetGross * 0.5) || projectedRoi < 5) {
    decision = "PASS";
  }

  return json(200, {
    ok: true,
    model,
    market_summary: clean(analysis.market_summary, 1800),
    retail_low: Math.round(retailLow),
    retail_mid: Math.round(retailMid),
    retail_high: Math.round(retailHigh),
    estimated_fees: Math.round(fees),
    estimated_transport: Math.round(transport),
    estimated_recon: Math.round(recon),
    estimated_labor: Math.round(labor),
    target_gross: Math.round(targetGross),
    current_ask: Math.round(currentAsk),
    recommended_purchase: Math.round(recommendedPurchase),
    projected_all_in: Math.round(projectedAllIn),
    projected_gross: Math.round(projectedGross),
    projected_roi: Math.round(projectedRoi * 10) / 10,
    decision,
    confidence: clean(analysis.confidence, 20) || "Low",
    assumptions: Array.isArray(analysis.assumptions) ? analysis.assumptions.map(v => clean(v, 400)).filter(Boolean) : [],
    evidence_notes: Array.isArray(analysis.evidence_notes) ? analysis.evidence_notes.map(v => clean(v, 400)).filter(Boolean) : [],
    source_urls: collectSourceUrls(data),
  });
};
