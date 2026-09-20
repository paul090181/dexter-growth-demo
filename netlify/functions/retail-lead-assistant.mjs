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
function sourceTypeFromLabel(source) {
  const value = String(source || "").toLowerCase();
  if (value.includes("instagram")) return "instagram";
  if (value.includes("facebook")) return "facebook";
  if (value.includes("email")) return "email";
  if (value.includes("website")) return "website";
  if (value.includes("text") || value.includes("sms")) return "sms";
  if (value.includes("phone")) return "phone";
  if (value.includes("manual")) return "manual";
  return "other";
}

function asksPrice(message) {
  return hasAny(message, [/how\s+much/,/price/,/cost/,/what.*\$/]);
}
function asksAvailability(message) {
  return hasAny(message, [/in\s+stock/,/available/,/still\s+have/,/do\s+you\s+have/,/got\s+this/]);
}
function productFactLead(product, message) {
  if (!product) return "";
  const parts = [];
  const name = product.name || "That item";
  const priceWanted = asksPrice(message);
  const stockWanted = asksAvailability(message);

  if (stockWanted && product.quantity !== null) {
    if (product.quantity > 0) parts.push(`${name} is currently showing in stock`);
    else parts.push(`${name} is currently showing out of stock`);
  }
  if (priceWanted && product.price) {
    const amount = Number(product.price);
    parts.push(Number.isFinite(amount) ? `the current listed price is $${amount.toFixed(2)}` : `the current listed price is $${product.price}`);
  }
  if (!parts.length) return "";
  return parts.join(", ") + ".";
}

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
    const id = clean(body.id, 120);
    const status = body.status == null ? "" : clean(body.status, 40);
    const hasStatus = status !== "";
    const hasUnread = typeof body.unread === "boolean";
    if (!id || (!hasStatus && !hasUnread)) return json(400, { error: "Lead id plus a status or unread update is required." });
    if (hasStatus && !["new","replied","follow-up","closed"].includes(status)) return json(400, { error: "Invalid lead status." });

    let rows;
    if (hasStatus && hasUnread) {
      rows = await db.sql`UPDATE retail_customer_leads
        SET status = ${status}, unread = ${body.unread}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND business_id = ${businessId}
        RETURNING *`;
    } else if (hasStatus) {
      rows = await db.sql`UPDATE retail_customer_leads
        SET status = ${status},
            unread = CASE WHEN ${status} = 'new' THEN unread ELSE FALSE END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND business_id = ${businessId}
        RETURNING *`;
    } else {
      rows = await db.sql`UPDATE retail_customer_leads
        SET unread = ${body.unread}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ${id} AND business_id = ${businessId}
        RETURNING *`;
    }
    if (!rows.length) return json(404, { error: "Lead not found." });
    return json(200, { ok: true, lead: rows[0] });
  }

  if (!openaiKey) return json(500, { error: "GrowthWise AI is not configured." });
  let body; try { body = await request.json(); } catch { return json(400, { error: "Invalid request." }); }

  const requestedAutomationMode = clean(body.automation_mode, 40) || "shadow";
  // Live delivery is intentionally disabled until a supported messaging channel is connected.
  const automationMode = requestedAutomationMode === "draft_only" ? "draft_only" : "shadow";
  const source = clean(body.source, 120) || "Customer message";
  const sourceType = sourceTypeFromLabel(source);
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

  const instructions = `You are GrowthWise Retail's customer lead assistant for ${business.name}. Draft concise, natural customer replies using only supplied business and product facts. Never invent price, stock, size, color, material, store hours, shipping eligibility/cost, return terms, custom-order availability, discounts, holds, restock dates, delivery dates, or promotions. Before using any selected product facts, compare the customer's wording with the selected product. Set product_match to matched only when the customer's described item is reasonably consistent with the selected product. Use mismatch when they clearly conflict, uncertain when the customer appears to reference a product but you cannot confidently tell whether the selected product is the same item, and no_product when no product was selected. If product_match is mismatch or uncertain, do not use the selected product's price, inventory, SKU, UPC, description, or other facts in the customer reply. Instead ask a short clarifying question that helps identify the correct product, such as asking for the product name/style or a photo. If a selected product has a numeric inventory quantity above 0 and product_match is matched, you may say it is currently showing in stock, but avoid promising future availability. If inventory is 0 and product_match is matched, say it is currently showing out of stock and offer to check alternatives. Never create or approve a discount, accept a negotiated price, promise a hold, promise shipping, approve a return/refund, promise a custom order, or resolve a complaint. Those require human review. For low-risk factual questions, decision may be auto_reply. For requests needing a business decision or verification, use auto_reply_then_review with a safe acknowledgement. Nothing will be auto-sent during this pilot.`;
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
          intent: { type: "string", enum: ["product_clarification","availability","price","product_details","size_color","store_visit","shipping","discount","hold","return_refund","custom_order","complaint","other"] },
          product_match: { type: "string", enum: ["matched","uncertain","mismatch","no_product"] },
          risk_level: { type: "string", enum: ["low","medium","high"] },
          decision: { type: "string", enum: ["auto_reply","auto_reply_then_review","review_required"] },
          reply: { type: "string" }, reason: { type: "string" }, follow_up_action: { type: "string" }
        }, required: ["intent","product_match","risk_level","decision","reply","reason","follow_up_action"]
      } } }
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return json(response.status, { error: String(data?.error?.message || "GrowthWise could not draft the reply.") });
  let result; try { result = JSON.parse(extractOutputText(data)); } catch { return json(502, { error: "GrowthWise returned an unreadable reply." }); }

  let intent = clean(result.intent, 80) || "other";
  let productMatch = ["matched","uncertain","mismatch","no_product"].includes(result.product_match)
    ? result.product_match
    : (product ? "uncertain" : "no_product");
  let risk = clean(result.risk_level, 40) || "medium";
  let decision = ["auto_reply","auto_reply_then_review"].includes(result.decision) ? result.decision : "review_required";
  let reply = clean(result.reply, 1800), reason = clean(result.reason, 1200), followUp = clean(result.follow_up_action, 1200);
  const discount = hasAny(message, [/discount/,/deal/,/lower\s+price/,/best\s+price/,/take\s+\$?\d/,/can\s+you\s+do\s+\$?\d/]);
  const hold = hasAny(message, [/\bhold\b/,/reserve/,/deposit/]);
  const shipping = hasAny(message, [/ship/,/delivery/,/mail\s+it/]);
  const returns = hasAny(message, [/return/,/refund/,/exchange/]);
  const custom = hasAny(message, [/custom/,/special\s+order/,/order\s+one/]);
  const complaint = hasAny(message, [/complaint/,/angry/,/upset/,/terrible/,/unacceptable/,/rip[ -]?off/,/scam/,/wrong\s+item/]);

  const productSpecificWithoutMatch =
    productMatch === "no_product" &&
    (asksPrice(message) || asksAvailability(message) || hold || discount);

  if (productMatch === "mismatch" || productMatch === "uncertain" || productSpecificWithoutMatch) {
    intent="product_clarification";
    risk="low";
    decision="auto_reply";
    reply = customerName
      ? `Hi ${customerName}, just to make sure I'm checking the right item, which product are you asking about? You can send the name or style, or a photo, and I'll check the current price and availability.`
      : "Just to make sure I'm checking the right item, which product are you asking about? You can send the name or style, or a photo, and I'll check the current price and availability.";
    reason = productMatch === "mismatch"
      ? "The customer's message appears inconsistent with the selected product, so GrowthWise will not use that product's price or inventory."
      : productMatch === "uncertain"
        ? "GrowthWise could not confidently confirm that the selected product is the item the customer means."
        : "The customer is asking a product-specific question, but no product has been identified yet.";
    followUp = "Wait for the customer to identify the product, then match the correct Square item before answering product-specific questions.";
  } else if (discount) {
    intent="discount"; risk="medium"; decision="auto_reply_then_review";
    const verifiedFacts = productFactLead(product, message);
    reply = verifiedFacts
      ? `${verifiedFacts} Dexter still needs to review whether any different price or offer is available.`
      : "Thanks for asking. I can have Dexter review the price or any available offer and get back to you.";
    reason="GrowthWise can answer verified product facts immediately, but pricing exceptions and discounts require store approval.";
    followUp="Dexter reviews whether any discount or promotion applies.";
  } else if (hold) {
    intent="hold"; risk="medium"; decision="auto_reply_then_review";
    const verifiedFacts = productFactLead(product, message);
    reply = verifiedFacts
      ? `${verifiedFacts} Dexter still needs to confirm whether it can be held for you, so I don't want to promise the hold until he confirms it.`
      : "Thanks — I can have Dexter confirm whether the item can be held for you. I don't want to promise a hold until he confirms it.";
    reason="GrowthWise can answer verified product facts immediately, but a hold changes inventory availability and requires store confirmation.";
    followUp="Dexter confirms whether a hold is allowed and for how long.";
  } else if (returns) {
    intent="return_refund"; risk="high"; decision="review_required"; reply="Thanks for reaching out. Dexter will review the purchase details and get back to you about the available options."; reason="Returns, exchanges and refunds require a human review."; followUp="Dexter reviews the purchase details and store policy before replying.";
  } else if (custom) {
    intent="custom_order"; risk="medium"; decision="auto_reply_then_review"; reply="Thanks for asking. I can have Dexter check whether that item or style can be special ordered and get back to you."; reason="Custom-order availability should be verified with the store or wholesaler."; followUp="Dexter checks supplier availability before promising the order.";
  } else if (complaint) {
    intent="complaint"; risk="high"; decision="auto_reply_then_review"; reply=`Hi${customerName ? ` ${customerName}` : ""}, thanks for letting us know. Dexter will review what happened and follow up with you directly.`; reason="GrowthWise can acknowledge the concern but should not admit fault or promise a remedy."; followUp="Priority human follow-up from Dexter.";
  } else if (shipping && !business.shipping_policy) {
    intent="shipping"; risk="medium"; decision="auto_reply_then_review"; reply="Thanks for asking. I can have Dexter confirm whether shipping is available for this item and what the options would be."; reason="No verified shipping policy was supplied."; followUp="Dexter confirms shipping availability and cost before promising anything.";
  }

  const automationClass =
    decision === "auto_reply" ? "safe_auto" :
    decision === "auto_reply_then_review" ? "safe_ack_then_review" :
    "human_only";
  const wouldAutoSend = automationMode === "shadow" && decision !== "review_required";
  const deliveryAction =
    automationMode === "draft_only" ? "manual_send" :
    decision === "auto_reply" ? "would_auto_reply" :
    decision === "auto_reply_then_review" ? "would_auto_ack_then_review" :
    "human_review_only";
  const automationReason =
    automationMode === "draft_only" ? "Draft-only mode is enabled." :
    decision === "auto_reply" ? "Shadow Mode judged this reply low-risk and grounded enough for future automatic sending." :
    decision === "auto_reply_then_review" ? "Shadow Mode would send only the safe acknowledgement, then route the decision or verification to Dexter." :
    "GrowthWise judged this message unsuitable for automatic sending.";

  const linkedProduct = productMatch === "matched" ? product : null;
  const id = crypto.randomUUID();
  await db.sql`INSERT INTO retail_customer_leads
    (id,business_id,source,source_type,customer_name,customer_contact,message,square_item_id,square_variation_id,product_name,intent,risk_level,decision,suggested_reply,follow_up_action,status,
     automation_mode,automation_class,would_auto_send,delivery_action,automation_reason,received_at,unread)
    VALUES (${id},${businessId},${source},${sourceType},${customerName || null},${customerContact || null},${message},${linkedProduct?.item_id || null},${linkedProduct?.variation_id || null},${linkedProduct?.name || null},${intent},${risk},${decision},${reply},${followUp},'new',
     ${automationMode},${automationClass},${wouldAutoSend},${deliveryAction},${automationReason},CURRENT_TIMESTAMP,TRUE)`;

  return json(200, {
    ok: true, id, model, intent, product_match: productMatch, risk_level: risk, decision, reply, reason, follow_up_action: followUp,
    automation_mode: automationMode,
    automation_class: automationClass,
    would_auto_send: wouldAutoSend,
    delivery_action: deliveryAction,
    automation_reason: automationReason,
    live_smart_locked: true
  });
};
