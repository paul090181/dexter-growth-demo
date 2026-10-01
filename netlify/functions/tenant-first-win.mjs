import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { hasEntitlement, resolveSubscriptionEntitlements } from "./_entitlements.mjs";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_CHARS = 7_500_000;

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

function extractOutputText(data) {
  for (const item of data?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item?.content || []) {
      if (part?.type === "output_text" && typeof part.text === "string") return part.text;
    }
  }
  return "";
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

const TYPE_LABELS = Object.freeze({
  retail: "retail shop",
  bakery_food: "bakery or food business",
  auto_dealer: "auto dealership",
  service: "service business",
  other: "small business",
});

const TASKS = new Set(["social_post", "customer_reply"]);

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    primary_text: { type: "string" },
    secondary_text: { type: "string" },
    note: { type: "string" },
    risk_level: { type: "string", enum: ["low", "medium", "high"] },
    next_step: { type: "string" },
  },
  required: ["title", "primary_text", "secondary_text", "note", "risk_level", "next_step"],
};

export function createTenantFirstWinHandler(options = {}) {
  const tenantStore = options.tenantStore ?? createTenantStore();
  const billingStore = options.billingStore ?? createBillingStore();
  const authorize = options.authorize ?? authorizeTenantRequest;
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name) ?? "");

  return async function tenantFirstWin(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, {
        error: error.status === 413 ? "That request is too large." : "Invalid request.",
      });
    }

    const businessId = clean(body?.business_id, 80);
    const task = clean(body?.task, 40);
    const prompt = clean(body?.prompt, 4000);
    const imageDataUrl = typeof body?.image_data_url === "string" ? body.image_data_url : "";

    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId) || !TASKS.has(task) || !prompt) {
      return json(400, { error: "Choose a first task and add a little context." });
    }

    if (imageDataUrl
      && (!/^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(imageDataUrl)
        || imageDataUrl.length > MAX_IMAGE_CHARS
        || task !== "social_post")) {
      return json(400, { error: "Use a JPG or PNG photo under 5 MB for social-post ideas." });
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
    if (!profile || profile.business_id !== businessId) {
      return json(404, { error: "Workspace not found." });
    }

    const entitlements = resolveSubscriptionEntitlements(subscription);
    const neededFeature = task === "social_post" ? "promotion_content" : "lead_reply_drafting";
    if (!hasEntitlement(entitlements, neededFeature)) {
      return json(403, { error: "This first-win task is not included in the current plan." });
    }

    const openaiKey = env("OPENAI_API_KEY");
    const model = env("OPENAI_MARKETING_MODEL") || env("OPENAI_LEAD_MODEL") || env("OPENAI_PRODUCT_MODEL") || "gpt-5.6-luna";
    if (!openaiKey) return json(503, { error: "Narleo AI is temporarily unavailable." });

    const businessName = clean(profile.business_name, 160);
    const businessType = TYPE_LABELS[profile.business_type] || TYPE_LABELS.other;
    const content = [{
      type: "input_text",
      text: task === "social_post"
        ? [
            "Create a polished first social post draft.",
            "Business: " + businessName,
            "Business type: " + businessType,
            "Owner context: " + prompt,
            "",
            "Use only facts supplied by the owner or clearly visible in the photo.",
            "Do not invent prices, discounts, stock levels, deadlines, ingredients, materials, features, guarantees, availability, or popularity.",
            "primary_text must be a Facebook-ready caption.",
            "secondary_text must be an Instagram-ready caption.",
            "Keep both concise and natural.",
          ].join("\n")
        : [
            "Draft a safe customer reply.",
            "Business: " + businessName,
            "Business type: " + businessType,
            "Customer message/context: " + prompt,
            "",
            "Do not invent price, stock, schedule, policy, shipping, discounts, custom-order availability, return outcomes, or promises.",
            "If an answer depends on missing business facts, ask a short clarifying question or say the team will confirm.",
            "primary_text must be the customer-ready reply.",
            "secondary_text should be empty.",
          ].join("\n"),
    }];

    if (imageDataUrl) {
      content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
    }

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
            "You are Narleo, a careful small-business assistant. Deliver a fast first useful result without requiring any integration. " +
            "Ground everything in supplied context. Never invent transactional facts. " +
            "For uncertain facts, keep wording general and make the next step clear. Return only structured data.",
          input: [{ role: "user", content }],
          text: {
            verbosity: "low",
            format: {
              type: "json_schema",
              name: "narleo_first_win",
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
      return json(response.status, { error: "Narleo could not create the first result right now." });
    }

    const output = extractOutputText(data);
    let result;
    try {
      result = JSON.parse(output);
    } catch {
      return json(502, { error: "Narleo returned an unreadable result." });
    }

    return json(200, {
      ok: true,
      business_id: businessId,
      business_type: profile.business_type || "other",
      task,
      model,
      title: clean(result.title, 220),
      primary_text: clean(result.primary_text, 2400),
      secondary_text: clean(result.secondary_text, 2400),
      note: clean(result.note, 900),
      risk_level: ["low", "medium", "high"].includes(result.risk_level) ? result.risk_level : "medium",
      next_step: clean(result.next_step, 900),
    });
  };
}

export default createTenantFirstWinHandler();
