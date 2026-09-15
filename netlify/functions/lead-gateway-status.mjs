import { authorized, json } from "./_lead-store.mjs";

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

  const ingestKeyConfigured = Boolean(Netlify.env.get("GROWTHWISE_LEAD_INGEST_KEY") || "");
  const origin = new URL(request.url).origin;

  return json(200, {
    ok: true,
    gateway_version: "v9",
    mode: "observe_only",
    accepts: ["application/json", "application/xml", "text/xml", "ADF/XML"],
    ingest_key_configured: ingestKeyConfigured,
    live_customer_sending_enabled: false,
    endpoint: `${origin}/.netlify/functions/lead-ingest`,
    monitor_endpoint: `${origin}/.netlify/functions/lead-intake-monitor`,
    safety: "External leads may be received, matched, analyzed and stored, but v9 cannot send a customer message.",
  });
};
