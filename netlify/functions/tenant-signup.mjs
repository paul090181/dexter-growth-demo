import { json } from "./_lead-store.mjs";
import { generateTenantCredentials } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

const MAX_BODY_BYTES = 8_192;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) throw Object.assign(new Error("REQUEST_TOO_LARGE"), { status: 413 });
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

function field(value, max) {
  const clean = typeof value === "string" ? value.trim() : "";
  return clean && clean.length <= max ? clean : "";
}

export function createTenantSignupHandler({ store } = {}) {
  return async function tenantSignupHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });

    let body;
    try {
      body = await readJson(request);
    } catch (error) {
      return json(error.status || 400, { error: error.status === 413 ? "Request too large." : "Invalid JSON." });
    }

    const businessName = field(body?.business_name, 160);
    const contactName = field(body?.contact_name, 160);
    const email = field(body?.email, 254).toLowerCase();
    if (!businessName || !contactName || !EMAIL_PATTERN.test(email)) {
      return json(400, { error: "Business name, contact name, and a valid email are required." });
    }

    const credentials = generateTenantCredentials({ businessName });
    try {
      await store.createTenant({
        businessId: credentials.businessId,
        businessName,
        contactName,
        email,
        accessKeyHash: credentials.accessKeyHash,
      });
      return json(201, {
        business_id: credentials.businessId,
        tenant_key: credentials.tenantKey,
        plan_key: "founding_monthly",
        status: "not_subscribed",
        access_granted: false,
      });
    } catch {
      return json(503, { error: "Signup is temporarily unavailable." });
    }
  };
}

export default function handler(request) {
  return createTenantSignupHandler({ store: createTenantStore() })(request);
}
