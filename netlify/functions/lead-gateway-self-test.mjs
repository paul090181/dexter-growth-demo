import { authorized, json } from "./_lead-store.mjs";

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

  const leadKey = Netlify.env.get("GROWTHWISE_LEAD_INGEST_KEY") || "";
  if (!leadKey) {
    return json(409, { error: "GROWTHWISE_LEAD_INGEST_KEY is not configured." });
  }

  const origin = new URL(request.url).origin;
  const externalId = `gw-secure-route-${Date.now()}`;
  const payload = {
    external_id: externalId,
    source: "GrowthWise Secure Gateway Self-Test",
    customer_name: "Gateway Test",
    customer_email: "gateway-test@example.test",
    message: "Is the 2018 Honda Odyssey still available? This is a secure external-route test only.",
    vehicle: {
      vehicle: "2018 Honda Odyssey",
      year: "2018",
      make: "Honda",
      model: "Odyssey",
      stock: "TEST-001",
    },
    business: {
      name: "Auto City Sales",
      market: "Buffalo, NY",
    },
    test: true,
  };

  try {
    const response = await fetch(`${origin}/.netlify/functions/lead-ingest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GrowthWise-Lead-Key": leadKey,
        "User-Agent": "GrowthWise-v9-secure-route-self-test",
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(response.status || 502, {
        error: data.error || `lead-ingest self-test failed (HTTP ${response.status}).`,
        lead_result: data,
      });
    }

    if (data?.delivery?.sent === true) {
      return json(500, {
        error: "Safety validation failed: the self-test unexpectedly reported a sent customer message.",
        lead_result: data,
      });
    }

    return json(200, {
      ok: true,
      gateway_version: "v9",
      credential_path_verified: true,
      used_browser_secret: false,
      test_traffic_only: true,
      customer_message_sent: false,
      lead_result: data,
      note: "The separate server-side lead-ingest credential successfully reached the production intake function. This self-test is marked TEST and is excluded from live monitor counts.",
    });
  } catch (err) {
    return json(500, { error: err?.message || "Could not run the secure gateway self-test." });
  }
};
