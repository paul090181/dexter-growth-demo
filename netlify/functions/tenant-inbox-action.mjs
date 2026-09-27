import { getDatabase } from "@netlify/database";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { hasEntitlement, resolveSubscriptionEntitlements } from "./_entitlements.mjs";

const PATH = "/.netlify/functions/tenant-inbox-action";
const MAX_BODY_BYTES = 8_192;

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

function cleanBusinessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) && clean.length <= 80 ? clean : "";
}

function cleanLeadId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return clean && clean.length <= 220 ? clean : "";
}

async function readBody(request) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("INVALID_BODY");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("INVALID_BODY");
  try { return JSON.parse(text || "{}"); }
  catch { throw new Error("INVALID_BODY"); }
}

async function defaultMarkRead({ businessId, leadId }) {
  const db = getDatabase();
  const rows = await db.sql`
    UPDATE retail_customer_leads
    SET unread = FALSE, updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ${businessId}
      AND id = ${leadId}
    RETURNING id, business_id, unread, status
  `;
  return rows?.[0] ?? null;
}

async function defaultSetStatus({ businessId, leadId, status }) {
  const db = getDatabase();
  const rows = await db.sql`
    UPDATE retail_customer_leads
    SET status = ${status},
        unread = FALSE,
        updated_at = CURRENT_TIMESTAMP
    WHERE business_id = ${businessId}
      AND id = ${leadId}
    RETURNING id, business_id, unread, status
  `;
  return rows?.[0] ?? null;
}

export function createTenantInboxActionHandler({
  tenantStore = createTenantStore(),
  billingStore = createBillingStore(),
  authorize = authorizeTenantRequest,
  markRead = defaultMarkRead,
  setStatus = defaultSetStatus,
  now = () => new Date(),
} = {}) {
  return async function tenantInboxAction(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); }
    catch { return json(400, { error: "Invalid request." }); }
    if (url.pathname !== PATH || url.search || url.hash) {
      return json(400, { error: "Invalid request." });
    }

    let body;
    try { body = await readBody(request); }
    catch { return json(400, { error: "Invalid request." }); }

    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).sort().join(",") !== "action,business_id,lead_id") {
      return json(400, { error: "Invalid request." });
    }

    const businessId = cleanBusinessId(body.business_id);
    const leadId = cleanLeadId(body.lead_id);
    const action = typeof body.action === "string" ? body.action : "";
    if (!businessId || !leadId
      || !new Set(["mark_read", "needs_follow_up", "close", "reopen"]).has(action)) {
      return json(400, { error: "Invalid request." });
    }

    const auth = await authorize(request, { businessId, store: tenantStore, now: now() });
    if (!auth?.ok || auth.businessId !== businessId) {
      return json(401, { error: "Tenant credentials are invalid." });
    }

    let subscription;
    try {
      subscription = await billingStore.readSubscription({ businessId });
    } catch {
      return json(503, { error: "Business account is temporarily unavailable." });
    }
    const entitlements = resolveSubscriptionEntitlements(subscription, { now: now() });
    if (!hasEntitlement(entitlements, "unified_inbox")) {
      return json(403, { error: "Unified inbox is not included in this plan." });
    }

    let row;
    try {
      row = action === "mark_read"
        ? await markRead({ businessId, leadId })
        : await setStatus({
            businessId,
            leadId,
            status: action === "needs_follow_up"
              ? "follow-up"
              : action === "close"
                ? "closed"
                : "new",
          });
    } catch {
      return json(503, { error: "Inbox could not be updated." });
    }
    if (!row || row.business_id !== businessId || String(row.id) !== leadId) {
      return json(404, { error: "Message was not found." });
    }

    return json(200, {
      ok: true,
      business_id: businessId,
      lead_id: leadId,
      unread: row.unread === true,
      status: typeof row.status === "string" ? row.status : null,
    });
  };
}

export default createTenantInboxActionHandler();
