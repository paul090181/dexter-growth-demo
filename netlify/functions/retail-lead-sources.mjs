import { getDatabase } from "@netlify/database";

const CATALOG = [
  ["instagram","Instagram"],
  ["facebook","Facebook"],
  ["email","Email"],
  ["website","Website"],
  ["sms","Text / SMS"],
  ["phone","Phone"],
  ["manual","Manual / Share"],
  ["other","Other"],
];

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async (request) => {
  if (request.method !== "GET") return json(405, { error: "Method not allowed." });
  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY") || "";
  if (!adminKey || request.headers.get("x-growthwise-key") !== adminKey) {
    return json(401, { error: "Invalid GrowthWise access key." });
  }

  const businessId = new URL(request.url).searchParams.get("business_id")?.trim() || "dexters-hats";
  const db = getDatabase();
  const rows = await db.sql`
    SELECT business_id,source_type,display_name,status,inbound_enabled,outbound_enabled,last_event_at,details,updated_at
      FROM growthwise_lead_sources
     WHERE business_id = ${businessId}
  `;
  const byType = new Map(rows.map((row) => [row.source_type, row]));
  const sources = CATALOG.map(([sourceType, displayName]) => {
    const row = byType.get(sourceType);
    if (row) return row;
    return {
      business_id: businessId,
      source_type: sourceType,
      display_name: displayName,
      status: sourceType === "manual" ? "ready" : "not_connected",
      inbound_enabled: sourceType === "manual",
      outbound_enabled: false,
      last_event_at: null,
      details: {},
    };
  });
  return json(200, { ok: true, business_id: businessId, sources });
};
