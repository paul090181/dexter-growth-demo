import { authorizeTenantPublishingRequest } from "./_tenant-publishing-auth.mjs";
import { createInstagramPublishHandler } from "./instagram-publish.mjs";

const INTERNAL_AUTH = "tenant-instagram-publish-authorized";

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
      },
    },
  };
}

export function createTenantInstagramPublishHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantPublishingRequest;
  const now = options.now ?? (() => new Date());

  return async function tenantInstagramPublish(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "JSON is required." });
    }

    let body;
    let raw;
    try {
      raw = await request.text();
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Invalid Instagram publish request." });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "Invalid Instagram publish request." });
    }
    const allowedKeys = new Set(["business_id", "caption", "image_data_url", "reviewed"]);
    if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
      return json(400, { error: "Invalid Instagram publish request." });
    }

    const businessId = cleanBusinessId(body.business_id);
    if (!businessId) return json(400, { error: "Invalid Instagram publish request." });

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

    const innerHandler = options.innerHandler ?? createInstagramPublishHandler({
      ...(options.instagramOptions ?? {}),
      adminKey: () => INTERNAL_AUTH,
      clients: { [businessId]: dynamicClient(businessId) },
      now,
    });

    const sourceUrl = new URL(request.url);
    const targetUrl = new URL("/.netlify/functions/instagram-publish", sourceUrl.origin);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.set("x-growthwise-key", INTERNAL_AUTH);
    headers.delete("content-length");
    headers.delete("cookie");

    const response = await innerHandler(new Request(targetUrl, {
      method: "POST",
      headers,
      body: raw,
    }));

    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json(response.status, {
        ...(typeof result?.code === "string" ? { code: result.code } : {}),
        error: typeof result?.error === "string"
          ? result.error
          : "Instagram could not publish the reviewed post.",
        ...(typeof result?.retry_safe === "boolean" ? { retry_safe: result.retry_safe } : {}),
      });
    }

    if (result?.ok !== true || result?.published !== true || result?.live_sent !== true) {
      return json(502, { error: "Instagram did not confirm the reviewed post." });
    }

    return json(200, {
      ok: true,
      business_id: businessId,
      published: true,
      live_sent: true,
      media_id: typeof result.media_id === "string" ? result.media_id : null,
      account: result.account && typeof result.account.username === "string"
        ? { username: result.account.username }
        : null,
    });
  };
}

export default createTenantInstagramPublishHandler();
