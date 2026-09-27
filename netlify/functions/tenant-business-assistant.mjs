import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { hasEntitlement, resolveSubscriptionEntitlements } from "./_entitlements.mjs";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_BODY_BYTES = 32_000;
const BUSINESS_TYPES = Object.freeze({
  retail: "retail shop",
  bakery_food: "bakery or food business",
  auto_dealer: "auto dealership",
  service: "service business",
  other: "small business",
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function clean(value, max = 4000) {
  return String(value ?? "").trim().slice(0, max);
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
  }
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw Object.assign(new Error("INVALID_JSON"), { status: 400 });
  }
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-6).map((item) => ({
    role: item?.role === "assistant" ? "assistant" : "user",
    text: clean(item?.text, 1800),
  })).filter((item) => item.text);
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

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    recommended_action: { type: "string" },
    context_status: {
      type: "string",
      enum: ["enough_to_help", "needs_more_business_data"],
    },
    data_needed: {
      type: "array",
      maxItems: 5,
      items: { type: "string" },
    },
    suggested_follow_ups: {
      type: "array",
      minItems: 1,
      maxItems: 3,
      items: { type: "string" },
    },
  },
  required: [
    "answer",
    "recommended_action",
    "context_status",
    "data_needed",
    "suggested_follow_ups",
  ],
};

export function createTenantBusinessAssistantHandler(options = {}) {
  const tenantStore = options.tenantStore ?? createTenantStore();
  const billingStore = options.billingStore ?? createBillingStore();
  const authorize = options.authorize ?? authorizeTenantRequest;
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name) ?? "");

  return async function tenantBusinessAssistant(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, {
        error: error.status === 413 ? "That question is too large." : "Invalid request.",
      });
    }

    const businessId = clean(body?.business_id, 80);
    const question = clean(body?.question, 4000);
    const history = normalizeHistory(body?.history);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId) || !question) {
      return json(400, { error: "Ask Narleo a business question first." });
    }

    const auth = await authorize(request, { businessId, store: tenantStore });
    if (!auth?.ok || auth.businessId !== businessId) {
      return json(401, { error: "Tenant credentials are invalid." });
    }

    let profile;
    let subscription;
    try {
      [profile, subscription] = await Promise.all([
        tenantStore.readTenantProfile({ businessId }),
        billingStore.readSubscription({ businessId }),
      ]);
    } catch {
      return json(503, { error: "Your workspace is temporarily unavailable." });
    }

    const entitlements = resolveSubscriptionEntitlements(subscription);
    if (!hasEntitlement(entitlements, "ai_business_assistant")) {
      return json(403, { error: "Narleo business assistant is not included in the current plan." });
    }

    const openaiKey = env("OPENAI_API_KEY");
    const model = env("OPENAI_BUSINESS_ASSISTANT_MODEL")
      || env("OPENAI_MARKETING_MODEL")
      || env("OPENAI_LEAD_MODEL")
      || "gpt-5.6-luna";
    if (!openaiKey) return json(503, { error: "Narleo AI is temporarily unavailable." });

    const businessName = clean(profile?.business_name, 160) || "this business";
    const businessType = BUSINESS_TYPES[profile?.business_type] || BUSINESS_TYPES.other;
    const historyText = history.length
      ? history.map((item) => (item.role === "assistant" ? "Narleo: " : "Owner: ") + item.text).join("\n")
      : "No previous conversation in this session.";

    let response;
    try {
      response = await fetchImpl(OPENAI_URL, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + openaiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning: { effort: "none" },
          instructions:
            "You are Narleo, an in-app small-business coach and business intelligence assistant. " +
            "Help the owner make practical decisions and save time. Distinguish known facts from ideas or assumptions. " +
            "Never pretend you can see sales, inventory, messages, website analytics, connected accounts, or customer data unless those facts are explicitly supplied in the conversation. " +
            "Never invent prices, margins, sales results, customer demand, stock, schedules, legal status, or integration status. " +
            "When the question depends on missing business data, still give useful general guidance, then state the specific data that would improve the answer. " +
            "Keep the owner inside Narleo by suggesting the next useful Narleo workflow when appropriate, but never pressure an upgrade or claim a feature exists when it has not been supplied. " +
            "Return only structured data.",
          input: [{
            role: "user",
            content: [{
              type: "input_text",
              text: [
                "Business: " + businessName,
                "Business type: " + businessType,
                "",
                "Recent in-session conversation:",
                historyText,
                "",
                "Owner's new question:",
                question,
              ].join("\n"),
            }],
          }],
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "narleo_business_assistant",
              strict: true,
              schema: SCHEMA,
            },
          },
        }),
      });
    } catch {
      return json(503, { error: "Narleo AI is temporarily unavailable." });
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(response.status, { error: "Narleo could not answer that right now." });
    }

    let result;
    try {
      result = JSON.parse(extractOutputText(data));
    } catch {
      return json(502, { error: "Narleo returned an unreadable answer." });
    }

    return json(200, {
      ok: true,
      business_id: businessId,
      business_type: profile?.business_type || "other",
      model,
      answer: clean(result.answer, 5000),
      recommended_action: clean(result.recommended_action, 1200),
      context_status: result.context_status === "needs_more_business_data"
        ? "needs_more_business_data"
        : "enough_to_help",
      data_needed: Array.isArray(result.data_needed)
        ? result.data_needed.map((item) => clean(item, 300)).filter(Boolean).slice(0, 5)
        : [],
      suggested_follow_ups: Array.isArray(result.suggested_follow_ups)
        ? result.suggested_follow_ups.map((item) => clean(item, 300)).filter(Boolean).slice(0, 3)
        : [],
    });
  };
}

export default createTenantBusinessAssistantHandler();
