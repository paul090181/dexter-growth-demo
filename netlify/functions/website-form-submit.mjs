import { getDatabase } from "@netlify/database";
import { ingestRetailLead, RetailLeadIngestError } from "./_retail-lead-ingest.mjs";
import { createWebsiteFormStore, WEBSITE_FORM_ID_PATTERN } from "./_website-form-store.mjs";

const PATH = "/.netlify/functions/website-form-submit";
const MAX_BODY_BYTES = 24 * 1024;
const RATE_LIMIT_PER_MINUTE = 20;
const SUBMISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("TOO_LARGE");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("TOO_LARGE");
  return JSON.parse(text || "{}");
}

async function defaultRecentCount({ businessId, db = getDatabase() }) {
  const rows = await db.sql`
    SELECT COUNT(*)::int AS count
      FROM retail_customer_leads
     WHERE business_id = ${businessId}
       AND source_type = 'website'
       AND created_at > CURRENT_TIMESTAMP - INTERVAL '1 minute'
  `;
  return Number(rows?.[0]?.count || 0);
}

export function createWebsiteFormSubmitHandler({
  formStore = createWebsiteFormStore(),
  recentCount = defaultRecentCount,
  ingest = ingestRetailLead,
  db = getDatabase(),
} = {}) {
  return async function websiteFormSubmit(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); } catch { return json(400, { error: "Invalid request." }); }
    if (url.pathname !== PATH || url.search || url.hash) return json(400, { error: "Invalid request." });
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "JSON is required." });
    }

    let body;
    try { body = await readBody(request); }
    catch (error) {
      return json(error?.message === "TOO_LARGE" ? 413 : 400, {
        error: error?.message === "TOO_LARGE" ? "That message is too large." : "Invalid form submission.",
      });
    }

    const expected = ["company_website", "email", "form_id", "message", "name", "phone", "submission_id"];
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).sort().join(",") !== expected.join(",")) {
      return json(400, { error: "Invalid form submission." });
    }

    const formId = clean(body.form_id, 80);
    const submissionId = clean(body.submission_id, 80);
    const name = clean(body.name, 180);
    const email = clean(body.email, 254).toLowerCase();
    const phone = clean(body.phone, 80);
    const message = clean(body.message, 4000);
    const honeypot = clean(body.company_website, 300);

    if (!WEBSITE_FORM_ID_PATTERN.test(formId)
      || !SUBMISSION_ID_PATTERN.test(submissionId)
      || !message
      || (!email && !phone)
      || (email && !EMAIL_PATTERN.test(email))) {
      return json(400, { error: "Please add a valid email or phone number and your message." });
    }

    if (honeypot) return json(200, { ok: true });

    let form;
    try { form = await formStore.readEnabledByFormId({ formId }); }
    catch { return json(503, { error: "This contact form is temporarily unavailable." }); }
    if (!form) return json(404, { error: "This contact form is unavailable." });

    try {
      if (await recentCount({ businessId: form.business_id, db }) >= RATE_LIMIT_PER_MINUTE) {
        return json(429, { error: "Too many messages were submitted just now. Please try again shortly." });
      }
    } catch {
      return json(503, { error: "This contact form is temporarily unavailable." });
    }

    let result;
    try {
      result = await ingest({
        business_id: form.business_id,
        source_type: "website",
        source: "Website form",
        customer_name: name,
        customer_contact: email || phone,
        message,
        external_message_id: submissionId,
        reply_target: email || phone,
        reply_supported: false,
        source_metadata: {
          hosted_form: true,
          email: email || undefined,
          phone: phone || undefined,
        },
      }, { db, ingestionTag: "website_form" });
    } catch (error) {
      if (error instanceof RetailLeadIngestError) {
        return json(error.status || 400, { error: "Your message could not be submitted." });
      }
      return json(503, { error: "Your message could not be submitted right now." });
    }

    return json(200, {
      ok: true,
      duplicate: result?.duplicate === true,
    });
  };
}

export default function handler(request) {
  return createWebsiteFormSubmitHandler()(request);
}
