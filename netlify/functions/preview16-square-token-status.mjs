function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function isPreview16(request) {
  try {
    const host = new URL(request.url).hostname;
    return host.startsWith("deploy-preview-16--") && host.endsWith(".netlify.app");
  } catch {
    return false;
  }
}

export default async function handler(request) {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });
  if (!isPreview16(request)) return json(404, { error: "Not found" });

  const token = Netlify.env.get("SQUARE_SANDBOX_TOKEN") || "";
  if (!token) return json(503, { ok: false, error: "Square sandbox unavailable" });

  try {
    const response = await fetch("https://connect.squareupsandbox.com/oauth2/token/status", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Square-Version": "2026-09-16",
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json(503, { ok: false, error: "Square status unavailable" });

    return json(200, {
      ok: true,
      client_id: typeof data.client_id === "string" ? data.client_id : null,
      merchant_id: typeof data.merchant_id === "string" ? data.merchant_id : null,
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
      expires_at: typeof data.expires_at === "string" ? data.expires_at : null,
      token_returned: false,
    });
  } catch {
    return json(503, { ok: false, error: "Square status unavailable" });
  }
}
