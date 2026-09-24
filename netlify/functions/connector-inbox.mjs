import { getDatabase } from "@netlify/database";
import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { connectorJson } from "./_connector-http.mjs";

const PATH = "/.netlify/functions/connector-inbox";
const MAX_ROWS = 100;
const RETURN_LIMIT = 30;
const INBOX_CONNECTORS = new Set(["email", "instagram", "facebook"]);

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

function safeLead(row) {
  return {
    id: String(row?.id ?? ""),
    source: String(row?.source ?? ""),
    source_type: String(row?.source_type ?? ""),
    source_account: row?.source_account == null ? null : String(row.source_account),
    customer_name: row?.customer_name == null ? null : String(row.customer_name),
    customer_contact: row?.customer_contact == null ? null : String(row.customer_contact),
    message: String(row?.message ?? ""),
    direction: String(row?.direction ?? "inbound"),
    received_at: row?.received_at ? new Date(row.received_at).toISOString() : null,
    unread: row?.unread !== false,
    reply_supported: row?.reply_supported === true,
    reply_target: row?.reply_target == null ? null : String(row.reply_target),
    status: String(row?.status ?? "new"),
    created_at: row?.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export function createConnectorInboxHandler({
  store = createConnectorStore(),
  now = () => new Date(),
  listTenantLeads = defaultListTenantLeads,
} = {}) {
  return async function connectorInbox(request) {
    if (request.method !== "GET") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "GET" });
    }

    let url;
    try { url = new URL(request.url); }
    catch { return connectorJson(400, { error: "Invalid request." }); }

    if (url.pathname !== PATH || url.search || url.hash) {
      return connectorJson(400, { error: "Invalid request." });
    }

    const auth = await authorizeConnectorRequest(request, { store, now: now() });
    if (!auth?.ok || typeof auth.businessId !== "string" || !auth.businessId) {
      return connectorJson(401, { error: "Session is invalid or expired." });
    }

    const allowedSources = new Set(
      (Array.isArray(auth.connectors) ? auth.connectors : [])
        .filter((connector) => INBOX_CONNECTORS.has(connector)),
    );
    if (!allowedSources.size) {
      return connectorJson(403, { error: "No inbox channel is available for this session." });
    }

    try {
      const rows = await listTenantLeads({ businessId: auth.businessId });
      const leads = (Array.isArray(rows) ? rows : [])
        .filter((row) => row?.business_id === auth.businessId && allowedSources.has(row?.source_type))
        .slice(0, RETURN_LIMIT)
        .map(safeLead);

      return connectorJson(200, {
        business_id: auth.businessId,
        sources: [...allowedSources].sort(),
        leads,
        count: leads.length,
      });
    } catch {
      return connectorJson(503, { error: "Inbox is temporarily unavailable." });
    }
  };
}

export default createConnectorInboxHandler();
