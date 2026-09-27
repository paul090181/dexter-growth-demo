import { authorizeTenantPublishingRequest } from "./_tenant-publishing-auth.mjs";
import { createInstagramConnectionHandler } from "./instagram-connection.mjs";

const INTERNAL_AUTH = "tenant-instagram-status-authorized";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

function cleanBusinessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) && clean.length <= 80 ? clean : "";
}

function dynamicClient(businessId) {
  return {
    business_id: businessId,
    integrations: {
      instagram: {
        review_publish_enabled: true,
        messages_enabled: false,
      },
    },
  };
}

export function createTenantInstagramConnectionHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantPublishingRequest;
  const now = options.now ?? (() => new Date());

  return async function tenantInstagramConnection(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); }
    catch { return json(400, { error: "Invalid request." }); }
    if (url.pathname !== "/.netlify/functions/tenant-instagram-connection"
      || url.hash
      || url.searchParams.size !== 1
      || url.searchParams.getAll("business_id").length !== 1) {
      return json(400, { error: "Invalid request." });
    }

    const businessId = cleanBusinessId(url.searchParams.get("business_id"));
    if (!businessId) return json(400, { error: "Invalid request." });

    const auth = await authorize(request, { businessId, now: now() });
    if (!auth?.ok || auth.businessId !== businessId) {
      const status = auth?.via === "locked" ? 403 : auth?.via === "unavailable" ? 503 : 401;
      return json(status, {
        error: status === 403
          ? "Instagram publishing is not included in this plan."
          : status === 503
            ? "Business account is temporarily unavailable."
            : "Tenant credentials are invalid.",
      });
    }

    const innerHandler = options.innerHandler ?? createInstagramConnectionHandler({
      ...(options.instagramOptions ?? {}),
      adminKey: () => INTERNAL_AUTH,
      clients: { [businessId]: dynamicClient(businessId) },
    });

    const target = new URL("/.netlify/functions/instagram-connection", url.origin);
    target.searchParams.set("business_id", businessId);
    const headers = new Headers(request.headers);
    headers.set("x-growthwise-key", INTERNAL_AUTH);
    headers.delete("cookie");
    headers.delete("x-growthwise-tenant-key");

    const response = await innerHandler(new Request(target, {
      method: "GET",
      headers,
    }));

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(response.status, {
        error: typeof body?.error === "string"
          ? body.error
          : "Instagram connection status is temporarily unavailable.",
      });
    }
    if (body?.business_id !== businessId || typeof body?.state !== "string") {
      return json(502, { error: "Instagram connection status was invalid." });
    }

    return json(200, {
      business_id: businessId,
      state: body.state,
      checked_at: body.checked_at ?? null,
      account: body.account ?? null,
      action: typeof body.action === "string" ? body.action : "",
    });
  };
}

export default createTenantInstagramConnectionHandler();
