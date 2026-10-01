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

function approvedOfferText(body) {
  if (body.offer_approved !== true) return "NO INCENTIVE HAS BEEN APPROVED. Customer-facing drafts must not mention a discount, coupon, free item, or promotional incentive.";

  const type = clean(body.offer_type, 40) || "dollar";
  const value = clean(body.offer_value, 160);
  const expiry = clean(body.offer_expiry, 40);
  const minimumSpend = clean(body.minimum_spend, 40);
  const maximumDiscount = clean(body.maximum_discount, 40);
  const details = clean(body.offer, 1200);

  let label = "";
  if (type === "dollar" && value) label = `$${value.replace(/^\$/, "")} off`;
  else if (type === "percent" && value) label = `${value.replace(/%$/, "")}% off`;
  else if (type === "free_addon" && value) label = `free ${value}`;
  else if (type === "custom" && value) label = value;

  const parts = [
    "INTERNAL OFFER STATUS: The business has authorized this offer for customer use. Do not mention the approval/authorization process to the customer. Present it naturally as an offer from the business, using phrasing such as 'we're offering', 'we'd like to offer', or 'you can receive'. Use these exact terms; do not change the economics:",
    label && `Offer: ${label}.`,
    expiry && `Expiration date: ${expiry}.`,
    minimumSpend && `Minimum spend: $${minimumSpend.replace(/^\$/, "")}.`,
    maximumDiscount && `Maximum discount: $${maximumDiscount.replace(/^\$/, "")}.`,
    details && `Approved offer/service details: ${details}`,
  ].filter(Boolean);

  if (!label && !details) {
    return "The shop marked an offer approved but no usable offer value/details were supplied. Do not invent an incentive; create the message without one.";
  }
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

  const action = clean(body.action, 40) || "compose_message";
  const businessName = clean(body.business_name, 120) || "the service center";
  const businessAddress = clean(body.business_address, 240);
  const businessPhone = clean(body.business_phone, 80);
  const businessWebsite = clean(body.business_website, 240);
  const mode = clean(body.mode, 80) || "service_followup";
  const customerName = clean(body.customer_name, 100);
  const vehicle = clean(body.vehicle, 200);
  const notes = clean(body.notes, 2500);
  const availability = clean(body.availability, 800);

  if (!notes && !availability) {
    return json(400, { error: "Add technician/service notes or open appointment details first." });
  }

  const facts = [
    `Business: ${businessName}`,
    businessAddress && `Address: ${businessAddress}`,
    businessPhone && `Phone: ${businessPhone}`,
    businessWebsite && `Website: ${businessWebsite}`,
    `Workflow: ${mode}`,
    customerName && `Customer: ${customerName}`,
    vehicle && `Vehicle: ${vehicle}`,
    notes && `Technician/service notes: ${notes}`,
    availability && `Appointment availability: ${availability}`,
  ].filter(Boolean).join("\n");

  try {
    if (action === "suggest_offer") {
      const result = await runStructured(
        openaiKey,
        model,
        `You are GrowthWise Automotive's internal service-retention strategist for ${businessName}. ` +
        "Your job is to recommend an incentive to the SHOP OWNER/STAFF, never directly to the customer. " +
        "You MAY propose a dollar discount, percentage discount, free add-on, custom offer, or no incentive. " +
        "Be conservative with margin: do not give away more value than is reasonably needed to motivate action. " +
        "Use the workflow, declined work, appointment capacity, and supplied facts. Do not invent repair facts, diagnoses, prices, customer history, or completed work. " +
        "If job price/cost/margin is unknown, explicitly say the owner should verify margin before approval. " +
        "For declined work, favor a modest re-engagement incentive when useful. For open bays, an urgency-based short-window offer may be appropriate. " +
        "For maintenance reminders, avoid discounting if a simple reminder is likely sufficient. " +
        "This is only a recommendation. The shop must approve or modify it before any customer-facing message is created. Return only structured data.",
        `Recommend the best service incentive strategy from these facts:\n\n${facts}`,
        "growthwise_service_offer_suggestion",
        {
          type: "object",
          additionalProperties: false,
          properties: {
            recommend_offer: { type: "boolean" },
            offer_type: { type: "string", enum: ["dollar", "percent", "free_addon", "custom", "none"] },
            offer_value: { type: "string" },
            expiration_days: { type: "integer", minimum: 0, maximum: 60 },
            minimum_spend: { type: "string" },
            maximum_discount: { type: "string" },
            offer_details: { type: "string" },
            rationale: { type: "string" },
            margin_caution: { type: "string" },
            confidence: { type: "string", enum: ["low", "medium", "high"] }
          },
          required: ["recommend_offer","offer_type","offer_value","expiration_days","minimum_spend","maximum_discount","offer_details","rationale","margin_caution","confidence"]
        }
      );

      return json(200, {
        ok: true,
        action,
        model,
        recommend_offer: Boolean(result.recommend_offer),
        offer_type: clean(result.offer_type, 40) || "none",
        offer_value: clean(result.offer_value, 160),
        expiration_days: Math.max(0, Math.min(60, Number(result.expiration_days) || 0)),
        minimum_spend: clean(result.minimum_spend, 40),
        maximum_discount: clean(result.maximum_discount, 40),
        offer_details: clean(result.offer_details, 1000),
        rationale: clean(result.rationale, 1600),
        margin_caution: clean(result.margin_caution, 1200),
        confidence: clean(result.confidence, 20) || "low",
      });
    }

    if (action !== "compose_message") return json(400, { error: "Unknown service AI action." });

    const offerText = approvedOfferText(body);
    const result = await runStructured(
      openaiKey,
      model,
      `You are GrowthWise Automotive's service-retention and service-marketing assistant for ${businessName}. ` +
      "Create customer-ready communication only after the shop has made the incentive decision. " +
      "Never invent a diagnosis, repair need, price, warranty, safety claim, completed work, appointment, discount, expiration date, minimum spend, maximum discount, or vehicle fact that was not supplied. " +
      "If an approved offer is supplied, the SMS and email MUST contain the exact approved economics and any supplied expiration date, minimum spend, and maximum discount. Never alter them. Do not say the offer was approved, authorized, or reviewed internally. Phrase it naturally from the business to the customer, such as 'we're offering...', 'we'd like to offer...', or 'schedule by X and receive...'. " +
      "If no incentive is approved, do not mention a discount, coupon, free add-on, or promotional incentive. " +
      "Use the business phone or website as the call to action when available. Do not use scare tactics. " +
      "If a technician note could represent a safety concern, describe only the supplied fact and recommend contacting the shop rather than making an unsupported safety claim. " +
      "SMS should be concise and conversational. Email should be polished. Social copy must never expose customer-specific information. " +
      "For declined-work or maintenance reminders, prioritize trust and respectful follow-up. For open-bay/service-special workflows, focus on filling capacity without sounding desperate or spammy. Return only structured data.",
      `Create the service-center communication package from these facts:\n\n${facts}\n\nApproved incentive decision:\n${offerText}`,
      "growthwise_service_message_package",
      {
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
    );

    return json(200, {
      ok: true,
      action,
      model,
      customer_sms: clean(result.customer_sms, 1000),
      email_subject: clean(result.email_subject, 300),
      email_body: clean(result.email_body, 4000),
      social_caption: clean(result.social_caption, 3000),
      staff_action: clean(result.staff_action, 1500),
      suggested_followup: clean(result.suggested_followup, 1000),
      caution_note: clean(result.caution_note, 1500),
    });
  } catch (err) {
    return json(502, { error: err?.message || "Service AI request failed." });
  }
};
