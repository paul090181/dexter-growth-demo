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

function normalizeVehicle(vehicle) {
  if (!vehicle || typeof vehicle !== "object") return null;
  return {
    vehicle: clean(vehicle.vehicle, 240),
    stock: clean(vehicle.stock, 80),
    vin: clean(vehicle.vin, 40),
    year: clean(vehicle.year, 10),
    make: clean(vehicle.make, 80),
    model: clean(vehicle.model, 100),
    trim: clean(vehicle.trim, 100),
    mileage: clean(vehicle.mileage, 80),
    asking: clean(vehicle.asking, 80),
    status: clean(vehicle.status, 80),
    notes: clean(vehicle.notes, 1800),
    days_on_lot: clean(vehicle.days_on_lot, 40),
  };
}

function hasSpecificOffer(message) {
  const m = String(message || "").toLowerCase();
  return /(?:would\s+you\s+(?:take|accept)|(?:my\s+)?offer(?:\s+is|\s+of)?|i(?:'|’)ll\s+(?:pay|do)|i\s+can\s+(?:pay|do)|can\s+you\s+do|how\s+about)\s*\$?\s*\d[\d,]*(?:\.\d{1,2})?/i.test(m) ||
    /\$\s*\d[\d,]*(?:\.\d{1,2})?[^?!.]{0,45}(?:today|cash|offer|take|deal)/i.test(m);
}

function isPriceFlexQuestion(message) {
  const m = String(message || "").toLowerCase();
  return /lowest\s+price|best\s+price|best\s+you\s+can\s+do|any\s+room|room\s+on\s+(?:the\s+)?price|flexib|negotiable|can\s+you\s+do\s+better|move\s+on\s+(?:the\s+)?price/i.test(m);
}

function hasSpecificAppointmentTime(message) {
  const m = String(message || "").toLowerCase();
  return /\b(?:at\s+)?(?:1[0-2]|0?[1-9])(?::[0-5]\d)?\s*(?:a\.?m\.?|p\.?m\.?)\b/i.test(m) ||
    /\b(?:noon|midday|midnight)\b/i.test(m);
}

function containsAny(message, patterns) {
  const m = String(message || "").toLowerCase();
  return patterns.some((re) => re.test(m));
}

function displayPrice(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const numeric = Number(raw.replace(/[$,\s]/g, ""));
  if (Number.isFinite(numeric)) return `$${Math.round(numeric).toLocaleString("en-US")}`;
  return raw;
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
  const model = Netlify.env.get("OPENAI_LEAD_MODEL") || Netlify.env.get("OPENAI_SERVICE_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
  if (!adminKey || !openaiKey) return json(500, { error: "Server AI configuration is incomplete." });

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) return json(401, { error: "Invalid GrowthWise admin key." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const mode = clean(body.mode, 40) || "smart";
  const source = clean(body.source, 120) || "Unknown source";
  const customerName = clean(body.customer_name, 100);
  const message = clean(body.message, 4000);
  const history = clean(body.history, 5000);
  const appointmentAvailability = clean(body.appointment_availability, 1800);
  const tone = clean(body.tone, 1800);
  const policy = clean(body.policy, 2200);
  const vehicle = normalizeVehicle(body.vehicle);
  const business = body.business && typeof body.business === "object" ? {
    name: clean(body.business.name, 160) || "Auto City Sales",
    address: clean(body.business.address, 240),
    phone: clean(body.business.phone, 100),
    website: clean(body.business.website, 220),
    market: clean(body.business.market, 140),
  } : { name: "Auto City Sales", address: "", phone: "", website: "", market: "" };

  if (!message) return json(400, { error: "An incoming customer message is required." });

  const vehicleFacts = vehicle ? [
    `Vehicle: ${vehicle.vehicle || [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ")}`,
    vehicle.stock && `Stock: ${vehicle.stock}`,
    vehicle.vin && `VIN: ${vehicle.vin}`,
    vehicle.mileage && `Mileage: ${vehicle.mileage}`,
    vehicle.asking && `Advertised asking price: ${vehicle.asking}`,
    vehicle.status && `Inventory status: ${vehicle.status}`,
    vehicle.days_on_lot && `Days on lot: ${vehicle.days_on_lot}`,
    vehicle.notes && `Known dealer notes: ${vehicle.notes}`,
  ].filter(Boolean).join("\n") : "No matched inventory vehicle was supplied.";

  const businessFacts = [
    `Business: ${business.name}`,
    business.address && `Address: ${business.address}`,
    business.phone && `Phone: ${business.phone}`,
    business.website && `Website: ${business.website}`,
    business.market && `Market: ${business.market}`,
  ].filter(Boolean).join("\n");

  const instructions = `You are GrowthWise Automotive's lead-response decision engine for ${business.name}.\n\n` +
    `Your job is to decide whether an incoming dealership lead is safe for automated reply and to draft the best factual response. ` +
    `Do not invent vehicle facts, availability, history, condition, financing terms, warranties, appointments, discounts, trade values, deposits, holds, or dealership policies. ` +
    `Use only facts explicitly supplied in the request. ` +
    `If a customer asks whether a vehicle is available, only say yes automatically when a matched inventory record is supplied and its status clearly indicates it is active/available and not sold. ` +
    `If there is no matched inventory record or availability is unclear, require review or ask a neutral follow-up without claiming availability. ` +
    `Never accept, reject, counter, or promise a negotiated price or discount. You MAY keep the conversation moving with a neutral pricing response. ` +
    `If the shopper asks for the lowest price, asks whether there is flexibility, or asks if the dealer can do better WITHOUT making a specific offer, and a verified advertised asking price is supplied, you may state that advertised price and invite the shopper to make an offer for the sales team to review. ` +
    `If the shopper MAKES A SPECIFIC OFFER or directly asks the dealer to accept a proposed price, draft a neutral acknowledgement such as: "Thanks for the offer. I'll have our sales team review it and get back to you as soon as possible. In the meantime, would you like to schedule a time to see the vehicle?" Do not imply acceptance, rejection, a counteroffer, or likely approval. Classify that as auto_reply_then_review in smart mode so the acknowledgement can be sent immediately while the offer is routed to a salesperson for the actual decision. ` +
    `Never promise financing approval/rates/payments, value a trade, promise a warranty, state accident/title/history facts that were not supplied, promise a deposit/hold, admit fault, or handle a complaint as if resolved. Those underlying decisions require human judgment. ` +
    `In smart mode, financing questions, trade-in questions, warranty/history questions, deposits/holds and complaints should usually receive a safe immediate acknowledgement or information-gathering reply, then be classified auto_reply_then_review so staff is involved only for the decision or verification that remains. Complaints should be treated as priority human follow-up after the acknowledgement. ` +
    `A simple request to schedule or see a vehicle can receive an automated reply asking the shopper for a preferred time. If the shopper proposes a specific clock time and verified appointment availability was NOT supplied, do not confirm the slot; acknowledge the request and say the team will confirm availability, then route it for review. ` +
    `If a matched vehicle is explicitly marked Sold or otherwise unavailable, you may truthfully say it is no longer available and offer to help find a similar vehicle. ` +
    `Replies should be concise, human, helpful and oriented toward the next step. Never say you are an AI unless asked. ` +
    `The automation mode is ${mode}. In smart mode, low-risk factual messages may be labeled auto_reply. In draft/off mode, still classify the risk accurately, but decision must be review_required because automatic sending is disabled.\n\n` +
    `Dealer-configured reply style: ${tone || "Friendly, brief and natural. Answer directly and move toward a visit/test drive when appropriate."}\n` +
    `Dealer approval policy: ${policy || "Escalate negotiation, financing, trade values, holds/deposits, warranties, complaints and uncertain facts."}`;

  const prompt = [
    businessFacts,
    `Lead source: ${source}`,
    customerName && `Customer name: ${customerName}`,
    vehicleFacts,
    history && `Previous conversation:\n${history}`,
    appointmentAvailability && `Verified appointment availability:\n${appointmentAvailability}`,
    `Incoming customer message:\n${message}`,
  ].filter(Boolean).join("\n\n");

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
      instructions,
      input: [{
        role: "user",
        content: [{ type: "input_text", text: `Evaluate this dealership lead and prepare the reply package:\n\n${prompt}` }],
      }],
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "growthwise_lead_reply",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              intent: {
                type: "string",
                enum: ["availability","appointment","price_info","negotiation","financing","trade","vehicle_details","vehicle_history","warranty","complaint","other"]
              },
              risk_level: { type: "string", enum: ["low","medium","high"] },
              decision: { type: "string", enum: ["auto_reply","auto_reply_then_review","review_required"] },
              reply: { type: "string" },
              reason: { type: "string" },
              follow_up_action: { type: "string" },
              appointment_requested: { type: "boolean" },
              customer_name: { type: "string" }
            },
            required: ["intent","risk_level","decision","reply","reason","follow_up_action","appointment_requested","customer_name"]
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
  if (!outputText) return json(502, { error: "AI returned no lead response." });

  let result;
  try { result = JSON.parse(outputText); }
  catch { return json(502, { error: "AI returned an unreadable lead response." }); }

  // Server-side guardrails override the model. These are intentionally stricter than the prompt.
  const rawDecision = clean(result.decision, 40);
  let decision = rawDecision === "auto_reply" ? "auto_reply" : rawDecision === "auto_reply_then_review" ? "auto_reply_then_review" : "review_required";
  let intent = clean(result.intent, 80) || "other";
  let reply = clean(result.reply, 1800);
  let reason = clean(result.reason, 1200);
  let followUpAction = clean(result.follow_up_action, 1200);
  let riskLevel = clean(result.risk_level, 40) || "medium";

  const specificOffer = hasSpecificOffer(message);
  const priceFlexQuestion = isPriceFlexQuestion(message);
  const specificAppointmentTime = hasSpecificAppointmentTime(message);
  const financingQuestion = containsAny(message, [/\bfinanc/i,/\bcredit\b/i,/\bapproved?\b/i,/monthly\s+payment/i,/down\s+payment/i,/interest\s+rate/i,/\bapr\b/i]);
  const tradeQuestion = containsAny(message, [/trade[ -]?in/i,/\btrade\b/i,/what.*(?:give|offer).*my\s+(?:car|truck|vehicle)/i]);
  const warrantyQuestion = containsAny(message, [/warrant/i,/guarantee/i,/covered\s+if/i]);
  const historyQuestion = containsAny(message, [/carfax/i,/autocheck/i,/accident/i,/clean\s+title/i,/salvage/i,/rebuilt\s+title/i,/vehicle\s+history/i,/flood/i,/lemon/i]);
  const depositHoldQuestion = containsAny(message, [/deposit/i,/hold\s+(?:it|the|this)/i,/reserve\s+(?:it|the|this)/i]);
  const complaintQuestion = containsAny(message, [/complaint/i,/rip[ -]?off/i,/scam/i,/lied/i,/misled/i,/angry/i,/upset/i,/problem\s+with\s+the\s+vehicle/i,/unacceptable/i,/want\s+(?:a\s+)?refund/i]);

  if (mode !== "smart") decision = "review_required";

  // A specific price offer gets a guaranteed neutral acknowledgement; the actual decision always goes to a person.
  if (specificOffer) {
    intent = "negotiation";
    reply = `Thanks for the offer. I'll have our sales team review it and get back to you as soon as possible. In the meantime, would you like to schedule a time to see the vehicle?`;
    reason = "The shopper made a specific offer. GrowthWise may acknowledge it, but cannot accept, reject, counter or imply approval.";
    followUpAction = "Route the offer to Mo or another salesperson for the actual pricing decision.";
    riskLevel = "medium";
    if (mode === "smart") decision = "auto_reply_then_review";
  } else if (priceFlexQuestion) {
    // "Lowest price?" is safe only when the currently advertised asking price is actually supplied.
    intent = "price_info";
    if (mode === "smart" && vehicle?.asking) {
      const asking = displayPrice(vehicle.asking);
      reply = `The vehicle is currently advertised at ${asking}. If you have an offer in mind, feel free to send it over and I'll have our sales team review it.`;
      reason = "GrowthWise may state the verified advertised price and invite an offer, but may not invent a discount or negotiate.";
      followUpAction = "Continue automatically unless the shopper makes a specific offer or asks for a decision that requires the sales team.";
      riskLevel = "low";
      decision = "auto_reply";
    } else {
      decision = "review_required";
    }
  } else if (intent === "negotiation" && decision === "auto_reply") {
    decision = "auto_reply_then_review";
  }

  // A requested exact appointment time is acknowledged but not confirmed unless real availability was supplied.
  if ((intent === "appointment" || specificAppointmentTime) && specificAppointmentTime && !appointmentAvailability) {
    intent = "appointment";
    reply = "Thanks — I can check that time for you. I'll have our team confirm the appointment availability with you shortly.";
    reason = "The shopper proposed a specific appointment time, but no verified calendar availability was supplied.";
    followUpAction = "Confirm the requested time from a real calendar or staff member before promising the appointment.";
    riskLevel = "medium";
    if (mode === "smart") decision = "auto_reply_then_review";
  }

  // A known sold vehicle can be answered automatically because the inventory status is explicit.
  const normalizedStatus = String(vehicle?.status || "").toLowerCase();
  const knownSold = vehicle && /sold|unavailable/.test(normalizedStatus);
  if (knownSold && (intent === "availability" || /still\s+available|available\??/i.test(message))) {
    intent = "availability";
    const name = vehicle.vehicle || [vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(" ") || "vehicle";
    reply = `Thanks for checking. The ${name} is no longer available. If you'd like, I can help you find a similar vehicle that is currently available.`;
    reason = "The matched inventory record is explicitly marked sold/unavailable, so GrowthWise can answer that fact without guessing.";
    followUpAction = "Offer similar active inventory if the shopper wants alternatives.";
    riskLevel = "low";
    if (mode === "smart") decision = "auto_reply";
  }

  // Without a matched vehicle, do not auto-answer inventory-specific intents.
  const inventorySensitive = new Set(["availability","price_info","vehicle_details","vehicle_history","warranty"]);
  if (!vehicle && inventorySensitive.has(intent)) decision = "review_required";

  // High-value intake categories can be acknowledged automatically in Smart mode while staff handles only the decision or verification that remains.
  const displayVehicle = vehicle?.vehicle || [vehicle?.year, vehicle?.make, vehicle?.model, vehicle?.trim].filter(Boolean).join(" ") || "vehicle";

  if (financingQuestion || intent === "financing") {
    intent = "financing";
    reply = `Thanks for reaching out${customerName ? `, ${customerName}` : ""}. We can't guarantee approval or quote a monthly payment until the application and financing options are reviewed. Our sales team can help go over the available options for the ${displayVehicle}. Would you like someone to contact you?`;
    reason = "Financing approval, rates and payment quotes require a person, but GrowthWise can safely acknowledge the question immediately without making a promise.";
    followUpAction = "Send the safe acknowledgement automatically, then alert the sales team for financing follow-up and application review.";
    riskLevel = "high";
    decision = mode === "smart" ? "auto_reply_then_review" : "review_required";
  } else if (tradeQuestion || intent === "trade") {
    intent = "trade";
    const hasYear = /\b(?:19|20)\d{2}\b/.test(message);
    const hasMileage = /\b\d{2,3}(?:,\d{3})?\s*(?:miles?|mi\b)|\b\d{2,3}k\s*(?:miles?|mi)?\b/i.test(message);
    const hasVin = /\b[A-HJ-NPR-Z0-9]{17}\b/i.test(message);
    const asks = [];
    if (!hasYear) asks.push("year");
    if (!/\b(?:ford|chevrolet|chevy|honda|toyota|nissan|jeep|dodge|ram|gmc|buick|cadillac|chrysler|subaru|mazda|kia|hyundai|volkswagen|vw|bmw|mercedes|audi|lexus|acura|lincoln|volvo|mitsubishi|infiniti)\b/i.test(message)) asks.push("make");
    if (!hasMileage) asks.push("mileage");
    asks.push("trim level", "overall condition");
    if (!hasVin) asks.push("VIN if available");
    asks.push("a few clear photos");
    const missing = asks.join(", ").replace(/, ([^,]*)$/, ", and $1");
    reply = `Absolutely. We can help with a trade appraisal. I have the details you've already shared, so no need to repeat them. Please send ${missing}. Our sales team will review everything before any trade value is quoted.`;
    reason = "GrowthWise can collect the missing appraisal facts without making the customer repeat details, but it must not estimate or promise a trade value.";
    followUpAction = "Keep collecting only the missing trade-in details automatically. Once enough information is gathered, alert the sales team with a complete appraisal request.";
    riskLevel = "high";
    decision = mode === "smart" ? "auto_reply_then_review" : "review_required";
  } else if (historyQuestion || intent === "vehicle_history") {
    intent = "vehicle_history";
    reply = `Thanks for asking${customerName ? `, ${customerName}` : ""}. I'll have our team verify the title and accident history for the ${displayVehicle} and get back to you. Once we confirm those details, I can also help you schedule a time to see it.`;
    reason = "Title and accident-history facts were not verified in the supplied vehicle record, so GrowthWise must not guess. It can acknowledge the question while the team verifies the facts.";
    followUpAction = "Send the acknowledgement automatically, then verify title/history from an approved source before providing those facts.";
    riskLevel = "high";
    decision = mode === "smart" ? "auto_reply_then_review" : "review_required";
  } else if (warrantyQuestion || intent === "warranty") {
    intent = "warranty";
    reply = `Thanks for asking${customerName ? `, ${customerName}` : ""}. I'll have our team verify what warranty or coverage, if any, applies to the ${displayVehicle} and get back to you so we don't give you incorrect information.`;
    reason = "Warranty or coverage details require verification; GrowthWise may acknowledge the question but cannot promise coverage.";
    followUpAction = "Send the acknowledgement automatically, then verify the applicable warranty/coverage before answering the customer.";
    riskLevel = "high";
    decision = mode === "smart" ? "auto_reply_then_review" : "review_required";
  } else if (depositHoldQuestion) {
    reply = `Thanks for asking. I can have our sales team review the hold or deposit options for the ${displayVehicle} and get back to you. I don't want to promise that the vehicle is reserved until they confirm it.`;
    reason = "GrowthWise may acknowledge a hold/deposit request, but it cannot promise a reservation or accept terms automatically.";
    followUpAction = "Send the acknowledgement automatically, then alert the sales team to confirm any hold/deposit terms.";
    riskLevel = "high";
    decision = mode === "smart" ? "auto_reply_then_review" : "review_required";
  } else if (complaintQuestion || intent === "complaint") {
    intent = "complaint";
    reply = `Hi${customerName ? ` ${customerName}` : ""}, I'm sorry you're dealing with this. I'll have our team review what happened and contact you to discuss next steps. Please send us a brief description of the issue and the best phone number to reach you at.`;
    reason = "This is a customer complaint. GrowthWise may acknowledge the concern immediately, but it must not admit fault, guarantee vehicle condition or promise a remedy.";
    followUpAction = "Send the acknowledgement automatically, then create a priority follow-up for Mo or another salesperson to review the complaint and contact the customer.";
    riskLevel = "high";
    decision = mode === "smart" ? "auto_reply_then_review" : "review_required";
  }

  return json(200, {
    ok: true,
    model,
    intent,
    risk_level: riskLevel,
    decision,
    reply,
    reason,
    follow_up_action: followUpAction,
    appointment_requested: Boolean(result.appointment_requested),
    customer_name: clean(result.customer_name, 100) || customerName,
  });
};
