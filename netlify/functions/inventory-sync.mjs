import { authorized, json, clean } from "./_lead-store.mjs";
import { saveInventorySnapshot } from "./_inventory-store.mjs";

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key",
      },
    });
  }
  if (request.method !== "POST") return json(405, { error: "Method not allowed" });
  if (!authorized(request).ok) return json(401, { error: "Invalid GrowthWise access code." });

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid JSON body." }); }

  const records = Array.isArray(body.records) ? body.records : [];
  if (records.length > 2000) return json(400, { error: "Inventory snapshot is too large." });

  try {
    const snapshot = await saveInventorySnapshot(records, body.business || {});
    return json(200, {
      ok: true,
      count: snapshot.records.length,
      synced_at: snapshot.synced_at,
      message: `Cloud inventory snapshot updated with ${snapshot.records.length} record${snapshot.records.length === 1 ? "" : "s"}.`,
    });
  } catch (err) {
    return json(500, { error: clean(err?.message || err, 1200) || "Could not sync inventory." });
  }
};
