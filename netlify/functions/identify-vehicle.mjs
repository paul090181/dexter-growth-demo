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

function clean(value, max = 1000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeConfidence(value) {
  let n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  // Vision models sometimes express confidence as a 0–1 fraction even when
  // the schema requests 0–100. Normalize fractional values without turning
  // an explicit "1%" result into 100%.
  if (n > 0 && n < 1) n *= 100;
  return Math.max(0, Math.min(100, n));
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

  const clues = [
    clean(body.year, 10) && `Dealer-entered year clue: ${clean(body.year, 10)}`,
    clean(body.make, 80) && `Dealer-entered make clue: ${clean(body.make, 80)}`,
    clean(body.model, 100) && `Dealer-entered model clue: ${clean(body.model, 100)}`,
  ].filter(Boolean).join("\n") || "No dealer-entered year/make/model clues were supplied.";

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      reasoning: { effort: "low" },
      instructions:
        "You are GrowthWise Vehicle ID. Identify a road vehicle from a dealer photo as cautiously as possible. " +
        "Your result is a suggestion for a human to confirm, never a guaranteed fact. Use visible styling, badges, lamps, grille, body shape and other visible identifiers. " +
        "Do not infer VIN, title, accident history, mechanical condition, engine, drivetrain, options, warranty or service history. " +
        "Only suggest a trim when a trim badge or other strong visual evidence supports it; otherwise return an empty trim. " +
        "If the exact model year cannot be distinguished visually, provide the most likely year plus a year range and lower confidence. " +
        "Report confidence on a 0–100 percentage scale (for example 92, not 0.92). " +
        "Return only the requested structured data.",
      input: [{
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Identify the most likely vehicle in this photo.\n\nOptional dealer clues:\n${clues}\n\nGive the strongest likely match, confidence, a concise explanation, and up to three reasonable alternatives.`
          },
          { type: "input_image", image_url: imageDataUrl, detail: "high" }
        ]
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_vehicle_identification",
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
              confidence: { type: "number", minimum: 0, maximum: 100 },
              explanation: { type: "string" },
              alternatives: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    year: { type: "string" },
                    make: { type: "string" },
                    model: { type: "string" },
                    confidence: { type: "number", minimum: 0, maximum: 100 }
                  },
                  required: ["year", "make", "model", "confidence"]
                }
              }
            },
            required: ["year", "year_range", "make", "model", "trim", "confidence", "explanation", "alternatives"]
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
  if (!outputText) return json(502, { error: "AI returned no vehicle identification." });

  let result;
  try { result = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable vehicle identification." }); }

  return json(200, {
    ok: true,
    model,
    year: clean(result.year, 10),
    year_range: clean(result.year_range, 40),
    make: clean(result.make, 80),
    vehicle_model: clean(result.model, 100),
    trim: clean(result.trim, 100),
    confidence: normalizeConfidence(result.confidence),
    explanation: clean(result.explanation, 1200),
    alternatives: Array.isArray(result.alternatives) ? result.alternatives.slice(0, 3).map(v => ({
      year: clean(v?.year, 10),
      make: clean(v?.make, 80),
      model: clean(v?.model, 100),
      confidence: normalizeConfidence(v?.confidence),
    })) : [],
  });
};
