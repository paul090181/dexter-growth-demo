import { authorized, json, listLeads } from "./_lead-store.mjs";

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key",
      },
    });
  }
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!authorized(request).ok) return json(401, { error: "Invalid GrowthWise access code." });

  try {
    const url = new URL(request.url);
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 40), 1), 100);
    const leads = await listLeads(limit);
    return json(200, { ok: true, leads, count: leads.length });
  } catch (err) {
    return json(500, { error: err?.message || "Could not load the cloud lead inbox." });
  }
};
