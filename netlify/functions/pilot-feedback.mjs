import { getDatabase } from "@netlify/database";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

export default async (request) => {
  if (!["GET","POST"].includes(request.method)) {
    return json(405, { error: "Method not allowed." });
  }

  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
  if (!adminKey || (request.headers.get("x-growthwise-key") || "") !== adminKey) {
    return json(401, { error: "Invalid GrowthWise access key." });
  }

  const db = getDatabase();

  if (request.method === "GET") {
    const businessId = clean(new URL(request.url).searchParams.get("business_id") || "dexters-hats", 120);
    const rows = await db.sql`
      SELECT id, business_id, feature, result, note, created_at
        FROM growthwise_pilot_feedback
       WHERE business_id = ${businessId}
       ORDER BY created_at DESC
       LIMIT 100
    `;
    return json(200, { ok: true, feedback: rows });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid request." }); }

  const businessId = clean(body.business_id || "dexters-hats", 120);
  const feature = clean(body.feature, 120);
  const result = clean(body.result, 40);
  const note = clean(body.note, 1200) || null;

  if (!businessId || !feature || !["worked","needs-improvement"].includes(result)) {
    return json(400, { error: "Choose the feature and whether it worked or needs improvement." });
  }

  const id = crypto.randomUUID();
  await db.sql`
    INSERT INTO growthwise_pilot_feedback
      (id, business_id, feature, result, note)
    VALUES
      (${id}, ${businessId}, ${feature}, ${result}, ${note})
  `;

  return json(201, { ok: true, id });
};
