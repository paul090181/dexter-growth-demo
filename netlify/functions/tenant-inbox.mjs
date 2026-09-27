import { getDatabase } from "@netlify/database";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createBillingStore } from "./_billing-store.mjs";
import { hasEntitlement, resolveSubscriptionEntitlements } from "./_entitlements.mjs";

const PATH = "/.netlify/functions/tenant-inbox";
const MAX_ROWS = 100;
const RETURN_LIMIT = 30;
const ALLOWED_SOURCES = new Set(["instagram", "facebook", "email", "website", "sms", "manual"]);

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

async function defaultListTenantLeads({ businessId }) {
  const db = getDatabase();
  return db.sql`
    SELECT
      id,
      business_id,
      source,
      source_type,
      source_account,
      customer_name,
      customer_contact,
      message,
      direction,
      received_at,
      unread,
      reply_supported,
      reply_target,
      status,
      created_at
    FROM retail_customer_leads
    WHERE business_id = ${businessId}
    ORDER BY created_at DESC
    LIMIT ${MAX_ROWS}
  `;
}

function safeText(value, max) {
  return value == null ? null : String(value).slice(0, max);
}

function safeLead(row) {
  return {
    id: safeText(row?.id, 220) || "",
    source: safeText(row?.source, 120) || "",
    source_type: safeText(row?.source_type, 40) || "",
    source_account: safeText(row?.source_account, 240),
    customer_name: safeText(row?.customer_name, 240),
    customer_contact: safeText(row?.customer_contact, 320),
    message: safeText(row?.message, 4000) || "",
    direction: safeText(row?.direction, 40) || "inbound",
    received_at: row?.received_at ? new Date(row.received_at).toISOString() : null,
    unread: row?.unread !== false,
    reply_supported: row?.reply_supported === true,
    reply_target: safeText(row?.reply_target, 320),
    status: safeText(row?.status, 80) || "new",
    created_at: row?.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function cleanBusinessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) && clean.length <= 80 ? clean : "";
}

export function createTenantInboxHandler({
  tenantStore = createTenantStore(),
  billingStore = createBillingStore(),
  authorize = authorizeTenantRequest,
  listTenantLeads = defaultListTenantLeads,
  now = () => new Date(),
} = {}) {
  return async function tenantInbox(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); }
    catch { return json(400, { error: "Invalid request." }); }
    if (url.pathname !== PATH
      || url.hash
      || url.searchParams.size !== 1
      || url.searchParams.getAll("business_id").length !== 1) {
      return json(400, { error: "Invalid request." });
    }

    const businessId = cleanBusinessId(url.searchParams.get("business_id"));
    if (!businessId) return json(400, { error: "Invalid request." });

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

    let rows;
    try {
      rows = await listTenantLeads({ businessId });
    } catch {
      return json(503, { error: "Inbox is temporarily unavailable." });
    }

    const leads = (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.business_id === businessId && ALLOWED_SOURCES.has(row?.source_type))
      .slice(0, RETURN_LIMIT)
      .map(safeLead);

    return json(200, {
      ok: true,
      business_id: businessId,
      count: leads.length,
      unread_count: leads.filter((lead) => lead.unread).length,
      leads,
    });
  };
}

export default createTenantInboxHandler();
