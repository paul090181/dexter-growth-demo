import {
  authorized,
  clean,
  getLead,
  json,
  leadKey,
  normalizeBusiness,
  normalizeVehicle,
  saveLead,
} from "./_lead-store.mjs";

function decodeXml(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

function tag(xml, name, attrs = "") {
  const attrPart = attrs ? `[^>]*${attrs}[^>]*` : "[^>]*";
  const re = new RegExp(`<${name}\\b${attrPart}>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = String(xml || "").match(re);
  return m ? decodeXml(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")) : "";
}

function attr(xml, tagName, attrName) {
  const re = new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, "i");
  return decodeXml(String(xml || "").match(re)?.[1] || "");
}

function parseAdf(xml) {
  const prospect = String(xml || "");
  const customerBlock = prospect.match(/<customer\b[^>]*>([\s\S]*?)<\/customer>/i)?.[1] || prospect;
  const vehicleBlock = prospect.match(/<vehicle\b[^>]*>([\s\S]*?)<\/vehicle>/i)?.[1] || "";
  const vendorBlock = prospect.match(/<vendor\b[^>]*>([\s\S]*?)<\/vendor>/i)?.[1] || "";
  const fullName = tag(customerBlock, "name", `part=["']full["']`) || tag(customerBlock, "name");
  const firstName = tag(customerBlock, "name", `part=["']first["']`);
  const lastName = tag(customerBlock, "name", `part=["']last["']`);
  const asking = tag(vehicleBlock, "price", `type=["']asking["']`) || tag(vehicleBlock, "price");
  const source = tag(vendorBlock, "vendorname") || tag(vendorBlock, "name") || tag(prospect, "provider") || "ADF/XML lead";
  const externalId = attr(prospect, "prospect", "id") || tag(prospect, "id") || tag(prospect, "requestdate");
  const year = tag(vehicleBlock, "year"), make = tag(vehicleBlock, "make"), model = tag(vehicleBlock, "model"), trim = tag(vehicleBlock, "trim");
  return {
    external_id: externalId,
    source,
    customer_name: fullName || [firstName, lastName].filter(Boolean).join(" "),
    customer_email: tag(customerBlock, "email"),
    customer_phone: tag(customerBlock, "phone"),
    message: tag(prospect, "comments") || tag(prospect, "comment") || "Customer submitted an online vehicle inquiry.",
    vehicle: normalizeVehicle({
      vehicle: [year, make, model, trim].filter(Boolean).join(" "),
      year, make, model, trim,
      vin: tag(vehicleBlock, "vin"),
      stock: tag(vehicleBlock, "stock"),
      mileage: tag(vehicleBlock, "odometer") || tag(vehicleBlock, "mileage"),
      asking,
      status: "For Sale",
    }),
    business: normalizeBusiness(null),
  };
}

async function parseIncoming(request) {
  const type = (request.headers.get("content-type") || "").toLowerCase();
  if (type.includes("xml") || type.includes("adf")) {
    const xml = await request.text();
    if (!xml.trim()) throw new Error("Empty XML body.");
    return parseAdf(xml);
  }
  let body;
  try { body = await request.json(); }
  catch { throw new Error("Invalid JSON body."); }
  return {
    external_id: clean(body.external_id || body.id || body.lead_id, 300),
    source: clean(body.source, 160) || "Unknown source",
    customer_name: clean(body.customer_name || body.name, 120),
    customer_email: clean(body.customer_email || body.email, 220),
    customer_phone: clean(body.customer_phone || body.phone, 80),
    message: clean(body.message || body.comments || body.body, 5000),
    history: clean(body.history, 6000),
    appointment_availability: clean(body.appointment_availability, 1800),
    vehicle: normalizeVehicle(body.vehicle),
    business: normalizeBusiness(body.business),
    test: Boolean(body.test),
  };
}

async function analyzeThroughExistingEngine(request, normalized) {
  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY") || "";
  if (!adminKey) throw new Error("GROWTHWISE_ADMIN_KEY is not configured.");
  const origin = new URL(request.url).origin;
  const response = await fetch(`${origin}/.netlify/functions/lead-assistant`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-GrowthWise-Key": adminKey },
    body: JSON.stringify({
      mode: "smart",
      source: normalized.source,
      customer_name: normalized.customer_name,
      message: normalized.message,
      history: normalized.history || "",
      appointment_availability: normalized.appointment_availability || "",
      vehicle: normalized.vehicle,
      business: normalized.business,
      tone: "Friendly, brief and natural. Do not sound like a bot. Answer directly, preserve dealership facts, and move toward a visit or useful next step when appropriate.",
      policy: "Use GrowthWise Smart Auto rules. Never accept/reject/counter a negotiated price; never promise financing approval, payments, trade values, warranty/history facts, deposits/holds, or complaint remedies without verified facts or human approval.",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Lead AI failed (HTTP ${response.status}).`);
  return data;
}

function deliveryPreview(analysis) {
  const d = analysis?.decision || "review_required";
  return {
    mode: "test_log",
    status: "not_sent",
    would_send: d === "auto_reply",
    would_acknowledge: d === "auto_reply_then_review",
    needs_human_before_send: d === "review_required",
    note: d === "auto_reply"
      ? "Live sender not connected. In Smart Auto mode this reply would be sent automatically."
      : d === "auto_reply_then_review"
        ? "Live sender not connected. GrowthWise would send the safe acknowledgement and then alert staff for the remaining decision."
        : "Live sender not connected. GrowthWise would hold this message for human review before sending.",
  };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-GrowthWise-Key, X-GrowthWise-Lead-Key",
      },
    });
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  const auth = authorized(request, { allowLeadKey: true });
  if (!auth.ok) return json(401, { error: "Invalid lead gateway credential." });

  let incoming;
  try { incoming = await parseIncoming(request); }
  catch (err) { return json(400, { error: err?.message || "Could not parse incoming lead." }); }
  if (!incoming.message) return json(400, { error: "Incoming lead message/comments are required." });

  const key = leadKey({ source: incoming.source, externalId: incoming.external_id });
  const existing = await getLead(key);
  if (existing) return json(200, { ok: true, duplicate: true, id: existing.id, lead: existing });

  const createdAt = new Date().toISOString();
  const id = key.replace(/^lead\//, "");
  const base = {
    _key: key,
    id,
    created_at: createdAt,
    updated_at: createdAt,
    source: incoming.source,
    external_id: incoming.external_id || "",
    customer_name: incoming.customer_name || "",
    customer_email: incoming.customer_email || "",
    customer_phone: incoming.customer_phone || "",
    message: incoming.message,
    history: incoming.history || "",
    vehicle: incoming.vehicle,
    business: incoming.business,
    test: Boolean(incoming.test || auth.via === "admin"),
    status: "processing",
    events: [{ at: createdAt, type: "received", detail: `Lead received through ${auth.via === "admin" ? "internal gateway test" : "external lead gateway"}.` }],
  };

  try {
    await saveLead(base, { onlyIfNew: true });
    const analysis = await analyzeThroughExistingEngine(request, incoming);
    const completedAt = new Date().toISOString();
    const record = {
      ...base,
      updated_at: completedAt,
      status: analysis.decision === "review_required" ? "human_review" : analysis.decision === "auto_reply_then_review" ? "ai_then_human" : "ai_handled",
      analysis,
      delivery: deliveryPreview(analysis),
      events: [
        ...base.events,
        { at: completedAt, type: "ai_analyzed", detail: `${analysis.intent || "other"} · ${analysis.decision || "review_required"}` },
        { at: completedAt, type: "delivery_preview", detail: deliveryPreview(analysis).note },
      ],
    };
    await saveLead(record);
    return json(200, {
      ok: true,
      duplicate: false,
      id,
      status: record.status,
      analysis,
      delivery: record.delivery,
      message: "Lead received, stored in the cloud inbox, and processed automatically. No real customer message was sent in v5 test-delivery mode.",
    });
  } catch (err) {
    const failedAt = new Date().toISOString();
    const failed = {
      ...base,
      updated_at: failedAt,
      status: "error",
      error: clean(err?.message || err, 1200),
      events: [...base.events, { at: failedAt, type: "error", detail: clean(err?.message || err, 1200) }],
    };
    try { await saveLead(failed); } catch {}
    return json(500, { error: err?.message || "Lead was received but could not be processed." });
  }
};
