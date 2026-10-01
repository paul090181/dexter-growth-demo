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

  const db = getDatabase();

  if (request.method === "GET") {
    const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");
    if (!adminKey || (request.headers.get("x-growthwise-key") || "") !== adminKey) {
      return json(401, { error: "Invalid GrowthWise access key." });
    }
    const rows = await db.sql`
      SELECT id, referral_code, referrer_business, name, business_name, contact,
             industry, message, source_path, status, created_at, updated_at
        FROM growthwise_interest_leads
       ORDER BY created_at DESC
       LIMIT 100
    `;
    return json(200, { ok: true, leads: rows });
  }

  let body;
  try { body = await request.json(); }
  catch { return json(400, { error: "Invalid request." }); }

  if (clean(body.website, 200)) {
    return json(200, { ok: true });
  }

  const name = clean(body.name, 120);
  const businessName = clean(body.business_name, 180);
  const contact = clean(body.contact, 220);
  const industry = clean(body.industry, 120) || null;
  const message = clean(body.message, 1200) || null;
  const referralCode = clean(body.referral_code, 120) || null;
  const referrerBusiness = clean(body.referrer_business, 180) || null;
  const sourcePath = clean(body.source_path, 300) || null;

  if (!name || !businessName || !contact) {
    return json(400, { error: "Name, business name and contact information are required." });
  }

  const id = crypto.randomUUID();
  await db.sql`
    INSERT INTO growthwise_interest_leads
      (id, referral_code, referrer_business, name, business_name, contact,
       industry, message, source_path)
    VALUES
      (${id}, ${referralCode}, ${referrerBusiness}, ${name}, ${businessName}, ${contact},
       ${industry}, ${message}, ${sourcePath})
  `;

  return json(201, {
    ok: true,
    message: "Thanks — your GrowthWise interest request was received."
  });
};
