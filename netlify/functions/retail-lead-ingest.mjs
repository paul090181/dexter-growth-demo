import { ingestRetailLead, RetailLeadIngestError } from "./_retail-lead-ingest.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Method not allowed." });

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY") || "";
  const ingestKey = Netlify.env.get("GROWTHWISE_RETAIL_LEAD_INGEST_KEY") || "";
  const supplied = request.headers.get("x-growthwise-key") || request.headers.get("x-growthwise-ingest-key") || "";
  if (!supplied || (supplied !== adminKey && supplied !== ingestKey)) {
    return json(401, { error: "Invalid GrowthWise retail lead-ingest key." });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid request." }); }

  try {
    const result = await ingestRetailLead(body, { ingestionTag: "normalized" });
    return json(result.duplicate ? 200 : 201, { ok: true, ...result });
  } catch (error) {
    if (error instanceof RetailLeadIngestError) return json(error.status, { error: error.message });
    throw error;
  }
};
