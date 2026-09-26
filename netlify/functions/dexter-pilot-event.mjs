import { getDatabase } from "@netlify/database";
import { authorized } from "./_lead-store.mjs";
import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";

const BUSINESS_ID = "dexters-hats";
const EVENTS = new Set([
  "pilot_opened",
  "instagram_photo_selected",
  "instagram_draft_created",
  "instagram_publish_succeeded",
  "instagram_publish_failed",
  "feedback_submitted",
]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createDexterPilotEventHandler({
  connectorStore = createConnectorStore(),
  connectorAuthorize = authorizeConnectorRequest,
  isAuthorized = authorized,
  getDb = getDatabase,
} = {}) {
  return async function dexterPilotEvent(request) {
    if (request.method === "GET") {
      if (!isAuthorized(request)?.ok) return json(401, { error: "Unauthorized." });
      const url = new URL(request.url);
      const businessId = url.searchParams.get("business_id") || BUSINESS_ID;
      if (businessId !== BUSINESS_ID) return json(400, { error: "Invalid pilot business." });
      const db = getDb();
      const rows = await db.sql`
        SELECT event_name, created_at
          FROM growthwise_pilot_events
         WHERE business_id = ${BUSINESS_ID}
         ORDER BY created_at DESC
         LIMIT 100
      `;
      return json(200, { ok: true, events: rows });
    }

    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const auth = await connectorAuthorize(request, {
      store: connectorStore,
      businessId: BUSINESS_ID,
      connector: "instagram",
      now: new Date(),
    });
    if (!auth?.ok || auth.businessId !== BUSINESS_ID) {
      return json(401, { error: "Dexter pilot session is invalid or expired." });
    }

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid request." }); }
    const eventName = typeof body?.event_name === "string" ? body.event_name.trim() : "";
    if (!EVENTS.has(eventName) || Object.keys(body || {}).length !== 1) {
      return json(400, { error: "Invalid pilot event." });
    }

    const db = getDb();
    await db.sql`
      INSERT INTO growthwise_pilot_events (business_id, event_name)
      VALUES (${BUSINESS_ID}, ${eventName})
    `;
    return json(201, { ok: true, event_name: eventName });
  };
}

export default createDexterPilotEventHandler();
