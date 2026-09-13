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
  const model = Netlify.env.get("OPENAI_SERVICE_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
  if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) return json(401, { error: "Invalid GrowthWise admin key." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const businessName = clean(body.business_name, 120) || "the service center";
  const mode = clean(body.mode, 80) || "service_followup";
  const customerName = clean(body.customer_name, 100);
  const vehicle = clean(body.vehicle, 200);
  const notes = clean(body.notes, 2500);
  const offer = clean(body.offer, 1200);
  const availability = clean(body.availability, 800);

  if (!notes && !offer && !availability) {
    return json(400, { error: "Add technician/service notes, an offer, or open appointment details first." });
  }

  const prompt = [
    `Business: ${businessName}`,
    `Workflow: ${mode}`,
    customerName && `Customer: ${customerName}`,
    vehicle && `Vehicle: ${vehicle}`,
    notes && `Technician/service notes: ${notes}`,
    offer && `Offer or service details: ${offer}`,
    availability && `Appointment availability: ${availability}`,
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
      reasoning: { effort: "none" },
      instructions:
        `You are GrowthWise Automotive's service-retention assistant for ${businessName}. ` +
        "Turn rough shop notes into professional, accurate customer communication and practical retention/marketing actions. " +
        "Never invent a diagnosis, repair need, price, warranty, safety claim, completed work, appointment, discount, or vehicle fact that was not supplied. " +
        "Do not use scare tactics. If a technician note could represent a safety concern, explain it neutrally and recommend that the customer contact the shop rather than making a definitive medical/safety-style claim. " +
        "SMS should be concise and conversational. Email should be polished. Social copy should never expose customer-specific information. " +
        "For open-bay/service-special workflows, prioritize a compelling but truthful offer and an easy call to action. " +
        "For declined-work or maintenance reminders, prioritize respectful follow-up and customer trust. Return only the requested structured data.",
      input: [{
        role: "user",
        content: [{
          type: "input_text",
          text: `Create a service-center communication package from these facts:\n\n${prompt}`,
        }],
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_service_package",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              customer_sms: { type: "string" },
              email_subject: { type: "string" },
              email_body: { type: "string" },
              social_caption: { type: "string" },
              staff_action: { type: "string" },
              suggested_followup: { type: "string" },
              caution_note: { type: "string" }
            },
            required: ["customer_sms","email_subject","email_body","social_caption","staff_action","suggested_followup","caution_note"]
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
  if (!outputText) return json(502, { error: "AI returned no service package." });

  let result;
  try { result = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable service package." }); }

  return json(200, {
    ok: true,
    model,
    customer_sms: clean(result.customer_sms, 1000),
    email_subject: clean(result.email_subject, 300),
    email_body: clean(result.email_body, 4000),
    social_caption: clean(result.social_caption, 3000),
    staff_action: clean(result.staff_action, 1500),
    suggested_followup: clean(result.suggested_followup, 1000),
    caution_note: clean(result.caution_note, 1500),
  });
};
