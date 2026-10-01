import { createTenantStore } from "./_tenant-store.mjs";
import { createWebsiteFormStore, WEBSITE_FORM_ID_PATTERN } from "./_website-form-store.mjs";

const PATH = "/.netlify/functions/website-form-info";
const MAX_BODY_BYTES = 2048;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("INVALID");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("INVALID");
  return JSON.parse(text || "{}");
}

export function createWebsiteFormInfoHandler({
  formStore = createWebsiteFormStore(),
  tenantStore = createTenantStore(),
} = {}) {
  return async function websiteFormInfo(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); } catch { return json(400, { error: "Invalid request." }); }
    if (url.pathname !== PATH || url.search || url.hash) return json(400, { error: "Invalid request." });

    let body;
    try { body = await readBody(request); } catch { return json(400, { error: "Invalid form link." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).sort().join(",") !== "form_id"
      || !WEBSITE_FORM_ID_PATTERN.test(String(body.form_id || ""))) {
      return json(400, { error: "Invalid form link." });
    }

    let form;
    try { form = await formStore.readEnabledByFormId({ formId: body.form_id }); }
    catch { return json(503, { error: "This contact form is temporarily unavailable." }); }
    if (!form) return json(404, { error: "This contact form is unavailable." });

    let tenant;
    try { tenant = await tenantStore.readTenantProfile({ businessId: form.business_id }); }
    catch { return json(503, { error: "This contact form is temporarily unavailable." }); }
    if (!tenant || tenant.business_id !== form.business_id) {
      return json(404, { error: "This contact form is unavailable." });
    }

    return json(200, {
      ok: true,
      business_name: tenant.business_name,
    });
  };
}

export default function handler(request) {
  return createWebsiteFormInfoHandler()(request);
}
