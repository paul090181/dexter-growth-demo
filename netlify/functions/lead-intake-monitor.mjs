import { authorized, json, listLeads } from "./_lead-store.mjs";

function sourceSummary(rows) {
  const counts = new Map();
  for (const row of rows) {
    const source = String(row?.source || "Unknown source").trim() || "Unknown source";
    counts.set(source, (counts.get(source) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
    .slice(0, 8);
}

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
    const rows = await listLeads(100);
    const live = rows.filter((row) => row?.live_external === true && row?.test !== true);
    const matched = live.filter((row) => row?.vehicle_match?.matched === true);
    const human = live.filter((row) => {
      const decision = String(row?.analysis?.decision || "");
      return row?.status === "human_review" || row?.status === "ai_then_human" || decision === "review_required" || decision === "auto_reply_then_review";
    });
    const errors = live.filter((row) => row?.status === "error" || row?.error);
    const autoHandled = live.filter((row) => String(row?.analysis?.decision || "") === "auto_reply");
    const last = live
      .map((row) => String(row?.created_at || ""))
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a))[0] || "";

    return json(200, {
      ok: true,
      gateway_version: "v9",
      mode: "observe_only",
      live_customer_sending_enabled: false,
      live_count: live.length,
      matched_count: matched.length,
      human_follow_up_count: human.length,
      auto_handle_count: autoHandled.length,
      error_count: errors.length,
      match_rate: live.length ? Math.round((matched.length / live.length) * 100) : null,
      last_live_received_at: last || null,
      sources: sourceSummary(live),
      sample_window: rows.length,
      note: "Metrics include only real external leads received with the separate lead-ingest credential. Internal JSON and ADF tests are excluded.",
    });
  } catch (err) {
    return json(500, { error: err?.message || "Could not build the live intake monitor." });
  }
};
