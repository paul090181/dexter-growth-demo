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

function approvedOfferText({ strategy, value, expiry, minimumSpend, maximumDiscount, details }) {
  const parts = [];
  if (strategy === "dollar" && value) parts.push(`Approved offer: $${String(value).replace(/^\$/, "")} off.`);
  if (strategy === "percent" && value) parts.push(`Approved offer: ${String(value).replace(/%$/, "")}% off.`);
  if (strategy === "free_addon" && value) parts.push(`Approved offer: free ${value}.`);
  if (strategy === "custom" && value) parts.push(`Approved custom offer: ${value}.`);
  if (strategy === "none") parts.push("The shop has approved no incentive for this communication.");
  if (strategy === "ai_recommend") parts.push("The shop wants AI to recommend whether an incentive would help, but no monetary or percentage discount is approved yet.");
  if (expiry) parts.push(`Offer expiration: ${expiry}.`);
  if (minimumSpend) parts.push(`Minimum spend: $${String(minimumSpend).replace(/^\$/, "")}.`);
  if (maximumDiscount) parts.push(`Maximum discount: $${String(maximumDiscount).replace(/^\$/, "")}.`);
  if (details) parts.push(`Offer/service details: ${details}`);
  return parts.join(" ");
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
  const businessAddress = clean(body.business_address, 240);
  const businessPhone = clean(body.business_phone, 80);
  const businessWebsite = clean(body.business_website, 240);
  const mode = clean(body.mode, 80) || "service_followup";
  const customerName = clean(body.customer_name, 100);
  const vehicle = clean(body.vehicle, 200);
  const notes = clean(body.notes, 2500);
  const offer = clean(body.offer, 1200);
  const availability = clean(body.availability, 800);
  const offerStrategy = clean(body.offer_strategy, 40) || "ai_recommend";
  const offerValue = clean(body.offer_value, 160);
  const offerExpiry = clean(body.offer_expiry, 40);
  const minimumSpend = clean(body.minimum_spend, 40);
  const maximumDiscount = clean(body.maximum_discount, 40);

  if (!notes && !offer && !availability) {
    return json(400, { error: "Add technician/service notes, an offer, or open appointment details first." });
  }

  const approvedOffer = approvedOfferText({
    strategy: offerStrategy,
    value: offerValue,
    expiry: offerExpiry,
    minimumSpend,
    maximumDiscount,
    details: offer,
  });

  const prompt = [
    `Business: ${businessName}`,
    businessAddress && `Address: ${businessAddress}`,
    businessPhone && `Phone: ${businessPhone}`,
    businessWebsite && `Website: ${businessWebsite}`,
    `Workflow: ${mode}`,
    customerName && `Customer: ${customerName}`,
    vehicle && `Vehicle: ${vehicle}`,
    notes && `Technician/service notes: ${notes}`,
    approvedOffer && `Incentive rules: ${approvedOffer}`,
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
        `You are GrowthWise Automotive's service-retention and service-marketing assistant for ${businessName}. ` +
        "Turn rough shop notes into professional, accurate customer communication and practical retention/marketing actions. " +
        "Never invent a diagnosis, repair need, price, warranty, safety claim, completed work, appointment, discount, expiration date, minimum spend, maximum discount, or vehicle fact that was not supplied. " +
        "If offer_strategy is ai_recommend, you may recommend whether an incentive would likely help, but you MUST NOT insert a dollar amount, percentage, free item, or other unapproved incentive into customer-facing SMS, email, or social copy. " +
        "If an approved offer is supplied, include its exact material terms naturally in the SMS and email when appropriate, including expiration, minimum-spend, and max-discount terms when provided. Do not improve or alter the approved economics. " +
        "If no incentive is approved, customer-facing drafts must not contain one. " +
        "Use the business phone or website as the call to action when available. Do not use scare tactics. " +
        "If a technician note could represent a safety concern, explain it neutrally and recommend contacting the shop rather than making an unsupported safety claim. " +
        "SMS should be concise and conversational. Email should be polished. Social copy must never expose customer-specific information. " +
        "For open-bay/service-special workflows, focus on filling capacity without sounding desperate or spammy. For declined-work or maintenance reminders, prioritize trust and respectful follow-up. " +
        "The offer_recommendation field is internal staff guidance: say whether an incentive is useful and why, and clearly state when an offer still requires owner approval. Return only the requested structured data.",
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
              offer_recommendation: { type: "string" },
              staff_action: { type: "string" },
              suggested_followup: { type: "string" },
              caution_note: { type: "string" }
            },
            required: ["customer_sms","email_subject","email_body","social_caption","offer_recommendation","staff_action","suggested_followup","caution_note"]
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
    offer_recommendation: clean(result.offer_recommendation, 1500),
    staff_action: clean(result.staff_action, 1500),
    suggested_followup: clean(result.suggested_followup, 1000),
    caution_note: clean(result.caution_note, 1500),
  });
};
