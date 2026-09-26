import { getDatabase } from "@netlify/database";
import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";

const BUSINESS_ID = "dexters-hats";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

export function createDexterPilotFeedbackHandler({
  connectorStore = createConnectorStore(),
  connectorAuthorize = authorizeConnectorRequest,
  getDb = getDatabase,
} = {}) {
  return async function dexterPilotFeedback(request) {
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

    const feature = clean(body?.feature, 120);
    const result = clean(body?.result, 40);
    const note = clean(body?.note, 1200) || null;
    if (!feature || !["worked","needs-improvement"].includes(result)
      || Object.keys(body || {}).some((key) => !["feature","result","note"].includes(key))) {
      return json(400, { error: "Choose the feature and whether it worked or needs improvement." });
    }

    const id = crypto.randomUUID();
    const db = getDb();
    await db.sql`
      INSERT INTO growthwise_pilot_feedback
        (id, business_id, feature, result, note)
      VALUES
        (${id}, ${BUSINESS_ID}, ${feature}, ${result}, ${note})
    `;
    return json(201, { ok: true, id });
  };
}

export default createDexterPilotFeedbackHandler();
