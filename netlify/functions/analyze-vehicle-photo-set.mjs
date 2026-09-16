const OPENAI_URL = "https://api.openai.com/v1/responses";
const NHTSA_DECODE = "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value, max = 2000) {
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

function validVin(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(String(vin || "").toUpperCase());
}

async function decodeVin(vin) {
  if (!validVin(vin)) return null;
  try {
    const r = await fetch(`${NHTSA_DECODE}/${encodeURIComponent(vin)}?format=json`, { headers: { Accept: "application/json" } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return null;
    const x = d?.Results?.[0] || {};
    const make = clean(x.Make, 80), model = clean(x.Model, 100), year = clean(x.ModelYear, 10);
    if (!make || !model || !year) return null;
    return {
      vin,
      year,
      make,
      model,
      trim: clean(x.Trim || x.Trim2, 100),
      body_class: clean(x.BodyClass, 120),
      vehicle_type: clean(x.VehicleType, 120),
      drive_type: clean(x.DriveType, 100),
      fuel_type: clean(x.FuelTypePrimary, 100),
      engine_cylinders: clean(x.EngineCylinders, 40),
      error_code: clean(x.ErrorCode, 100),
      error_text: clean(x.ErrorText, 500),
    };
  } catch {
    return null;
  }
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key" },
    });
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey = Netlify.env.get("OPENAI_API_KEY");
  const model = Netlify.env.get("OPENAI_AUTOMOTIVE_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
  if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });
  if ((request.headers.get("x-growthwise-key") || "") !== adminKey) return json(401, { error: "Invalid GrowthWise admin key." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const incoming = Array.isArray(body?.photos) ? body.photos : [];
  const photos = incoming.slice(0, 8).map((p) => ({
    slot_id: clean(p?.slot_id, 60),
    label: clean(p?.label, 120),
    kind: clean(p?.kind, 20),
    image_data_url: clean(p?.image_data_url, 2_500_000),
  })).filter(p => p.slot_id && p.image_data_url.startsWith("data:image/"));

  if (!photos.length) return json(400, { error: "Add at least one vehicle photo before AI analysis." });

  const knownVehicle = clean(body?.known_vehicle, 220);
  const knownMileage = clean(body?.known_mileage, 40);

  const content = [{
    type: "input_text",
    text:
      "Analyze this dealership vehicle photo set. Each image is labeled with its intended shot. Use cross-photo evidence, not a single image guess. " +
      "Read the odometer or VIN only when the text is clearly legible. If uncertain, leave it blank and lower confidence. " +
      "Do not infer title status, accident history, service history, drivetrain, engine, ownership, warranty, mechanical condition, or hidden damage. " +
      "Visible condition notes must describe only what can actually be seen. Pick the strongest marketing hero from the supplied public photo slots. " +
      (knownVehicle ? `Dealer-entered vehicle clue: ${knownVehicle}. ` : "") +
      (knownMileage ? `Dealer-entered mileage clue: ${knownMileage}. ` : "")
  }];

  for (const p of photos) {
    content.push({ type: "input_text", text: `PHOTO SLOT: ${p.label} | slot_id=${p.slot_id} | ${p.kind === "internal" ? "INTERNAL" : "PUBLIC MARKETING"}` });
    content.push({ type: "input_image", image_url: p.image_data_url, detail: p.kind === "internal" ? "high" : "auto" });
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "low" },
      instructions:
        "You are GrowthWise Automotive Photo Intelligence. Your job is to turn a vehicle photo set into cautious, dealership-usable structured observations. " +
        "Never invent exact vehicle facts. Distinguish likely visual identification from verified VIN-derived facts. " +
        "For year/trim, be conservative because adjacent model years and trims can look alike. " +
        "Return only the requested structured data.",
      input: [{ role: "user", content }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_vehicle_photo_set_analysis",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              year: { type: "string" },
              year_range: { type: "string" },
              make: { type: "string" },
              model: { type: "string" },
              trim: { type: "string" },
              identity_confidence: { type: "number", minimum: 0, maximum: 100 },
              identity_explanation: { type: "string" },
              body_style: { type: "string" },
              exterior_color: { type: "string" },
              visible_features: { type: "array", items: { type: "string" }, maxItems: 8 },
              visible_condition_notes: { type: "array", items: { type: "string" }, maxItems: 6 },
              odometer_value: { type: "string" },
              odometer_confidence: { type: "number", minimum: 0, maximum: 100 },
              vin_candidate: { type: "string" },
              vin_confidence: { type: "number", minimum: 0, maximum: 100 },
              hero_slot_id: { type: "string", enum: ["front_three_quarter","driver_side","rear_three_quarter","passenger_side","front_interior","rear_seats","cargo","wheels_tires",""] },
              hero_reason: { type: "string" },
              photo_quality_summary: { type: "string" },
              photo_quality_issues: { type: "array", items: { type: "string" }, maxItems: 6 },
              missing_critical_photos: { type: "array", items: { type: "string" }, maxItems: 6 },
              safe_marketing_facts: { type: "array", items: { type: "string" }, maxItems: 8 }
            },
            required: ["year","year_range","make","model","trim","identity_confidence","identity_explanation","body_style","exterior_color","visible_features","visible_condition_notes","odometer_value","odometer_confidence","vin_candidate","vin_confidence","hero_slot_id","hero_reason","photo_quality_summary","photo_quality_issues","missing_critical_photos","safe_marketing_facts"]
          }
        }
      }
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json(response.status || 502, { error: String(data?.error?.message || data?.error || `OpenAI request failed (HTTP ${response.status}).`) });

  const outputText = extractOutputText(data);
  if (!outputText) return json(502, { error: "AI returned no usable photo analysis." });

  let result;
  try { result = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable photo analysis." }); }

  const vinCandidate = clean(result.vin_candidate, 24).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const vinDecoded = Number(result.vin_confidence) >= 80 && validVin(vinCandidate) ? await decodeVin(vinCandidate) : null;

  return json(200, {
    ok: true,
    model,
    photos_analyzed: photos.length,
    visual_identity: {
      year: clean(result.year, 10),
      year_range: clean(result.year_range, 40),
      make: clean(result.make, 80),
      model: clean(result.model, 100),
      trim: clean(result.trim, 100),
      confidence: Math.max(0, Math.min(100, Number(result.identity_confidence) || 0)),
      explanation: clean(result.identity_explanation, 1200),
    },
    vin: {
      candidate: validVin(vinCandidate) ? vinCandidate : "",
      confidence: Math.max(0, Math.min(100, Number(result.vin_confidence) || 0)),
      decoded: vinDecoded,
    },
    odometer: {
      value: clean(result.odometer_value, 40),
      confidence: Math.max(0, Math.min(100, Number(result.odometer_confidence) || 0)),
    },
    body_style: clean(result.body_style, 80),
    exterior_color: clean(result.exterior_color, 80),
    visible_features: Array.isArray(result.visible_features) ? result.visible_features.map(x => clean(x, 180)).filter(Boolean).slice(0, 8) : [],
    visible_condition_notes: Array.isArray(result.visible_condition_notes) ? result.visible_condition_notes.map(x => clean(x, 220)).filter(Boolean).slice(0, 6) : [],
    hero_slot_id: clean(result.hero_slot_id, 60),
    hero_reason: clean(result.hero_reason, 600),
    photo_quality_summary: clean(result.photo_quality_summary, 700),
    photo_quality_issues: Array.isArray(result.photo_quality_issues) ? result.photo_quality_issues.map(x => clean(x, 220)).filter(Boolean).slice(0, 6) : [],
    missing_critical_photos: Array.isArray(result.missing_critical_photos) ? result.missing_critical_photos.map(x => clean(x, 180)).filter(Boolean).slice(0, 6) : [],
    safe_marketing_facts: Array.isArray(result.safe_marketing_facts) ? result.safe_marketing_facts.map(x => clean(x, 220)).filter(Boolean).slice(0, 8) : [],
  });
};
