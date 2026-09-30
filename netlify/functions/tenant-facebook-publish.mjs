import { createFacebookCrypto } from "./_facebook-crypto.mjs";
import { createFacebookStore } from "./_facebook-store.mjs";
import {
  FacebookPublishingError,
  publishFacebookPagePost,
  verifyFacebookPublishingPage,
} from "./_facebook-publishing.mjs";
import { authorizeTenantFacebookPublishingRequest } from "./_tenant-facebook-auth.mjs";

const MAX_BODY_BYTES = 32 * 1024 * 1024;

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

function env(name) {
  return globalThis.Netlify?.env?.get(name) ?? "";
}

function versions(name) {
  return { current: { id: "v1", key: env(name) } };
}

function createCrypto() {
  return createFacebookCrypto({
    stateSecrets: versions("GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

function cleanBusinessId(value) {
  const clean = typeof value === "string" ? value.trim() : "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(clean) && clean.length <= 80 ? clean : "";
}

function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const allowed = new Set([
    "business_id",
    "reviewed",
    "message",
    "expected_page_name",
    "image_data_url",
    "image_data_urls",
  ]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return null;

  const businessId = cleanBusinessId(body.business_id);
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const expectedPageName = typeof body.expected_page_name === "string"
    ? body.expected_page_name.trim().slice(0, 220)
    : "";
  const imageDataUrl = typeof body.image_data_url === "string" ? body.image_data_url : "";
  const imageDataUrls = Array.isArray(body.image_data_urls) ? body.image_data_urls : null;

  if (!businessId || body.reviewed !== true || !message) return null;
  if (imageDataUrls && imageDataUrls.some((value) => typeof value !== "string")) return null;

  return {
    businessId,
    message,
    expectedPageName,
    imageDataUrl,
    imageDataUrls,
  };
}

function authFailure(auth) {
  if (auth?.via === "locked") {
    return json(403, { error: "Facebook publishing is not included in this plan." });
  }
  if (auth?.via === "unavailable") {
    return json(503, { error: "Business account is temporarily unavailable." });
  }
  return json(401, { error: "Tenant credentials are invalid." });
}

export function createTenantFacebookPublishHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantFacebookPublishingRequest;
  const now = options.now ?? (() => new Date());
  const fetchImpl = options.fetchImpl ?? fetch;

  return async function tenantFacebookPublish(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "JSON is required." });
    }

    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
      return json(413, { error: "Facebook publish request is too large." });
    }

    let body;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
        return json(413, { error: "Facebook publish request is too large." });
      }
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "Invalid request." });
    }

    const input = validateBody(body);
    if (!input) {
      return json(400, {
        error: "Review the Facebook post and choose the correct business before publishing.",
      });
    }

    const auth = await authorize(request, {
      businessId: input.businessId,
      now: now(),
    });
    if (!auth?.ok || auth.businessId !== input.businessId) return authFailure(auth);

    let crypto;
    let store;
    try {
      crypto = options.crypto ?? createCrypto();
      store = options.store ?? createFacebookStore({ crypto });
    } catch {
      return json(503, { error: "Facebook publishing is temporarily unavailable." });
    }

    let credential;
    try {
      credential = await store.readDecryptedCredential({ businessId: input.businessId });
    } catch {
      return json(409, {
        code: "FACEBOOK_RECONNECT_REQUIRED",
        error: "Reconnect this business's Facebook Page before publishing.",
      });
    }

    if (!credential || credential.status !== "active") {
      return json(409, {
        code: "FACEBOOK_RECONNECT_REQUIRED",
        error: "Connect this business's Facebook Page before publishing.",
      });
    }

    const payload = credential.payload;
    const pageId = typeof payload?.page_id === "string" ? payload.page_id : "";
    const pageAccessToken = typeof payload?.page_access_token === "string"
      ? payload.page_access_token
      : "";
    const graphVersion = typeof payload?.graph_version === "string"
      ? payload.graph_version
      : env("FACEBOOK_GRAPH_VERSION") || "v26.0";
    const permissions = Array.isArray(payload?.permissions) ? payload.permissions : [];

    if (!pageId || !pageAccessToken || !permissions.includes("pages_manage_posts")) {
      return json(409, {
        code: "FACEBOOK_PUBLISHING_PERMISSION_REQUIRED",
        error: "Reconnect Facebook and approve Page publishing access before posting.",
      });
    }

    try {
      const identity = await (options.verifyPage ?? verifyFacebookPublishingPage)({
        pageId,
        pageAccessToken,
        graphVersion,
        fetchImpl,
      });

      if (input.expectedPageName
        && identity.pageName.toLowerCase() !== input.expectedPageName.toLowerCase()) {
        return json(409, {
          code: "FACEBOOK_PAGE_MISMATCH",
          error: "Publishing blocked because this workspace expected “"
            + input.expectedPageName
            + "” but Facebook returned “"
            + identity.pageName
            + "”.",
          page_name: identity.pageName,
        });
      }

      const result = await (options.publishPost ?? publishFacebookPagePost)({
        pageId,
        pageAccessToken,
        graphVersion,
        message: input.message,
        imageDataUrl: input.imageDataUrl,
        imageDataUrls: input.imageDataUrls,
        fetchImpl,
      });

      try {
        await store.updateCredentialHealth({
          businessId: input.businessId,
          status: "active",
          pageName: identity.pageName,
          lastVerifiedAt: now(),
        });
      } catch {}

      return json(200, {
        ok: true,
        business_id: input.businessId,
        page_name: identity.pageName,
        post_type: result.postType,
        post_id: result.postId,
        photo_count: result.photoCount,
      });
    } catch (error) {
      if (error instanceof FacebookPublishingError) {
        if (["FACEBOOK_RECONNECT_REQUIRED", "FACEBOOK_PUBLISHING_PERMISSION_REQUIRED"].includes(error.code)) {
          try {
            await store.updateCredentialHealth({
              businessId: input.businessId,
              status: "needs_attention",
              pageName: credential.page_name || null,
              lastVerifiedAt: now(),
            });
          } catch {}
        }
        return json(error.httpStatus || 502, {
          code: error.code,
          error: error.message,
        });
      }

      return json(502, {
        code: "FACEBOOK_PUBLISH_FAILED",
        error: "Facebook could not publish the reviewed post.",
      });
    }
  };
}

export default createTenantFacebookPublishHandler();
