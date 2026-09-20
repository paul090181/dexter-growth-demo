import { getDatabase } from "@netlify/database";

const OPENAI_URL = "https://api.openai.com/v1/responses";

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function clean(value, max = 5000) { return String(value ?? "").trim().slice(0, max); }
function extractOutputText(data) {
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) if (part?.type === "output_text" && typeof part.text === "string") return part.text;
  }
  return "";
}
function normalizeProduct(product) {
  if (!product || typeof product !== "object") return null;
  return {
    item_id: clean(product.item_id, 120), variation_id: clean(product.variation_id, 120),
    name: clean(product.item_name || product.name, 220), variation: clean(product.variation_name, 160),
    sku: clean(product.sku, 120), upc: clean(product.upc, 120), price: clean(product.price, 80),
    quantity: Number.isFinite(Number(product.quantity)) ? Number(product.quantity) : null,
    description: clean(product.description, 1800),
  };
}
function hasAny(message, patterns) { return patterns.some((re) => re.test(String(message || "").toLowerCase())); }

export default async (request) => {
  if (!["GET", "POST", "PATCH"].includes(request.method)) return json(405, { error: "Method not allowed." });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  const openaiKey = Netlify.env.get("OPENAI_API_KEY");
  const model = Netlify.env.get("OPENAI_LEAD_MODEL") || Netlify.env.get("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
  if (!adminKey) return json(500, { error: "GrowthWise is not configured." });
  if ((request.headers.get("x-growthwise-key") || "") !== adminKey) return json(401, { error: "Invalid GrowthWise access key." });

  const db = getDatabase();
  const url = new URL(request.url);
  const businessId = clean(url.searchParams.get("business_id") || "dexters-hats", 120);

  if (request.method === "GET") {
    const rows = await db.sql`SELECT * FROM retail_customer_leads WHERE business_id = ${businessId} ORDER BY created_at DESC LIMIT 100`;
    return json(200, { ok: true, leads: rows });
  }

  if (request.method === "PATCH") {
    let body; try { body = await request.json(); } catch { return json(400, { error: "Invalid request." }); }
    const id = clean(body.id, 120), status = clean(body.status, 40);
    if (!id || !["new","replied","follow-up","closed"].includes(status)) return json(400, { error: "Valid lead and status are required." });
    const rows = await db.sql`UPDATE retail_customer_leads SET status = ${status}, updated_at = CURRENT_TIMESTAMP WHERE id = ${id} AND business_id = ${businessId} RETURNING *`;
    if (!rows.length) return json(404, { error: "Lead not found." });
    return json(200, { ok: true, lead: rows[0] });
  }

  if (!openaiKey) return json(500, { error: "GrowthWise AI is not configured." });
  let body; try { body = await request.json(); } catch { return json(400, { error: "Invalid request." }); }

  const source = clean(body.source, 120) || "Customer message";
  const customerName = clean(body.customer_name, 120);
  const customerContact = clean(body.customer_contact, 180);
  const message = clean(body.message, 4000);
  const history = clean(body.history, 4000);
  const product = normalizeProduct(body.product);
  const business = {
    name: clean(body.business?.name, 180) || "Dexter's Hats & Caps",
    location: clean(body.business?.location, 220), hours: clean(body.business?.hours, 600),
    shipping_policy: clean(body.business?.shipping_policy, 800), return_policy: clean(body.business?.return_policy, 800),
    custom_order_policy: clean(body.business?.custom_order_policy, 800),
  };
  if (!message) return json(400, { error: "Paste or type the customer's message first." });

  const productFacts = product ? [
    `Product: ${product.name || "Selected product"}`, product.variation && `Variation: ${product.variation}`,
    product.sku && `SKU: ${product.sku}`, product.upc && `UPC: ${product.upc}`,
    product.price && `Current listed price: $${product.price}`,
    product.quantity !== null && `Current inventory quantity: ${product.quantity}`,
    product.description && `Known description: ${product.description}`,
  ].filter(Boolean).join("\n") : "No specific product was matched.";

  const instructions = `You are GrowthWise Retail's customer lead assistant for ${business.name}. Draft concise, natural customer replies using only supplied business and product facts. Never invent price, stock, size, color, material, store hours, shipping eligibility/cost, return terms, custom-order availability, discounts, holds, restock dates, delivery dates, or promotions. If a selected product has a numeric inventory quantity above 0, you may say it is currently showing in stock, but avoid promising future availability. If inventory is 0, say it is currently showing out of stock and offer to check alternatives. Never create or approve a discount, accept a negotiated price, promise a hold, promise shipping, approve a return/refund, promise a custom order, or resolve a complaint. Those require human review. For low-risk factual questions, decision may be auto_reply. For requests needing a business decision or verification, use auto_reply_then_review with a safe acknowledgement. Nothing will be auto-sent during this pilot.`;
  const prompt = [
    `Business: ${business.name}`, business.location && `Location: ${business.location}`, business.hours && `Known hours: ${business.hours}`,
    business.shipping_policy && `Known shipping policy: ${business.shipping_policy}`, business.return_policy && `Known return policy: ${business.return_policy}`,
    business.custom_order_policy && `Known custom-order policy: ${business.custom_order_policy}`, `Lead source: ${source}`,
    customerName && `Customer: ${customerName}`, productFacts, history && `Conversation history:\n${history}`, `Incoming message:\n${message}`,
  ].filter(Boolean).join("\n\n");

  const response = await fetch(OPENAI_URL, {
    method: "POST", headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, store: false, reasoning: { effort: "none" }, instructions,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      text: { verbosity: "low", format: { type: "json_schema", name: "growthwise_retail_lead", strict: true, schema: {
        type: "object", additionalProperties: false,
        properties: {
          intent: { type: "string", enum: ["availability","price","product_details","size_color","store_visit","shipping","discount","hold","return_refund","custom_order","complaint","other"] },
          risk_level: { type: "string", enum: ["low","medium","high"] },
          decision: { type: "string", enum: ["auto_reply","auto_reply_then_review","review_required"] },
          reply: { type: "string" }, reason: { type: "string" }, follow_up_action: { type: "string" }
        }, required: ["intent","risk_level","decision","reply","reason","follow_up_action"]
      } } }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json(response.status, { error: String(data?.error?.message || "GrowthWise could not draft the reply.") });
  let result; try { result = JSON.parse(extractOutputText(data)); } catch { return json(502, { error: "GrowthWise returned an unreadable reply." }); }

  let intent = clean(result.intent, 80) || "other";
  let risk = clean(result.risk_level, 40) || "medium";
  let decision = ["auto_reply","auto_reply_then_review"].includes(result.decision) ? result.decision : "review_required";
  let reply = clean(result.reply, 1800), reason = clean(result.reason, 1200), followUp = clean(result.follow_up_action, 1200);
  const discount = hasAny(message, [/discount/,/deal/,/lower\s+price/,/best\s+price/,/take\s+\$?\d/,/can\s+you\s+do\s+\$?\d/]);
  const hold = hasAny(message, [/\bhold\b/,/reserve/,/deposit/]);
  const shipping = hasAny(message, [/ship/,/delivery/,/mail\s+it/]);
  const returns = hasAny(message, [/return/,/refund/,/exchange/]);
  const custom = hasAny(message, [/custom/,/special\s+order/,/order\s+one/]);
  const complaint = hasAny(message, [/complaint/,/angry/,/upset/,/terrible/,/unacceptable/,/rip[ -]?off/,/scam/,/wrong\s+item/]);

  if (discount) {
    intent="discount"; risk="medium"; decision="auto_reply_then_review"; reply="Thanks for asking. I can have Dexter review the price or any available offer and get back to you."; reason="Pricing exceptions and discounts require store approval."; followUp="Dexter reviews whether any discount or promotion applies.";
  } else if (hold) {
    intent="hold"; risk="medium"; decision="auto_reply_then_review"; reply="Thanks — I can have Dexter confirm whether the item can be held for you. I don't want to promise a hold until he confirms it."; reason="A hold changes inventory availability and requires store confirmation."; followUp="Dexter confirms whether a hold is allowed and for how long.";
  } else if (returns) {
    intent="return_refund"; risk="high"; decision="review_required"; reply="Thanks for reaching out. Dexter will review the purchase details and get back to you about the available options."; reason="Returns, exchanges and refunds require a human review."; followUp="Dexter reviews the purchase details and store policy before replying.";
  } else if (custom) {
    intent="custom_order"; risk="medium"; decision="auto_reply_then_review"; reply="Thanks for asking. I can have Dexter check whether that item or style can be special ordered and get back to you."; reason="Custom-order availability should be verified with the store or wholesaler."; followUp="Dexter checks supplier availability before promising the order.";
  } else if (complaint) {
    intent="complaint"; risk="high"; decision="auto_reply_then_review"; reply=`Hi${customerName ? ` ${customerName}` : ""}, thanks for letting us know. Dexter will review what happened and follow up with you directly.`; reason="GrowthWise can acknowledge the concern but should not admit fault or promise a remedy."; followUp="Priority human follow-up from Dexter.";
  } else if (shipping && !business.shipping_policy) {
    intent="shipping"; risk="medium"; decision="auto_reply_then_review"; reply="Thanks for asking. I can have Dexter confirm whether shipping is available for this item and what the options would be."; reason="No verified shipping policy was supplied."; followUp="Dexter confirms shipping availability and cost before promising anything.";
  }

  const id = crypto.randomUUID();
  await db.sql`INSERT INTO retail_customer_leads
    (id,business_id,source,customer_name,customer_contact,message,square_item_id,square_variation_id,product_name,intent,risk_level,decision,suggested_reply,follow_up_action,status)
    VALUES (${id},${businessId},${source},${customerName || null},${customerContact || null},${message},${product?.item_id || null},${product?.variation_id || null},${product?.name || null},${intent},${risk},${decision},${reply},${followUp},'new')`;

  return json(200, { ok: true, id, model, intent, risk_level: risk, decision, reply, reason, follow_up_action: followUp });
};
