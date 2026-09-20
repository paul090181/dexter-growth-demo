import growthwiseDev from "../../clients/growthwise-dev.json" with { type: "json" };
import dextersHats from "../../clients/dexters-hats.json" with { type: "json" };
import { createInstagramCrypto } from "./_instagram-crypto.mjs";
import { instagramDatabase } from "./_instagram-store.mjs";
import { verifyProfessionalIdentity, INSTAGRAM_CONTENT_PUBLISH_SCOPE } from "./_instagram-oauth.mjs";
import { stageInstagramImage } from "./_instagram-media-store.mjs";
import {
  createInstagramImageContainer,
  publishInstagramContainer,
  InstagramPublishError,
} from "./_instagram-publishing.mjs";

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const EXPIRY_SAFETY_MS = 60_000;
const CLIENTS = Object.freeze({
  [growthwiseDev.business_id]: growthwiseDev,
  [dextersHats.business_id]: dextersHats,
});

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }
function defaultCrypto() {
  return createInstagramCrypto({
    stateSecrets: versions("GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"),
  });
}
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
function scopes(value) {
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string");
  return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
}
function configuredGraphVersion() {
  return env("GROWTHWISE_INSTAGRAM_GRAPH_VERSION") || env("FACEBOOK_GRAPH_VERSION") || "v26.0";
}

async function readRequestJson(request) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new RangeError("Request too large.");
  }
  return request.json();
}

export function createInstagramPublishHandler(options = {}) {
  const adminKey = options.adminKey ?? (() => env("GROWTHWISE_ADMIN_KEY") ?? "");
  const clients = options.clients ?? CLIENTS;
  const now = options.now ?? (() => new Date());
  const logger = options.logger ?? console;

  return async function instagramPublish(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const expectedKey = adminKey();
    if (!expectedKey || request.headers.get("x-growthwise-key") !== expectedKey) {
      return json(401, { error: "Invalid GrowthWise access code." });
    }
    if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      return json(415, { error: "JSON is required." });
    }

    let requestUrl;
    try { requestUrl = new URL(request.url); } catch { return json(400, { error: "Invalid Instagram publish request." }); }
    if (requestUrl.protocol !== "https:" || requestUrl.pathname !== "/.netlify/functions/instagram-publish"
      || requestUrl.username || requestUrl.password || requestUrl.search || requestUrl.hash) {
      return json(400, { error: "Invalid Instagram publish request." });
    }

    let body;
    try { body = await readRequestJson(request); }
    catch { return json(400, { error: "Invalid Instagram publish request." }); }

    const businessId = body?.business_id;
    const client = clients[businessId];
    if (!client || client.business_id !== businessId) return json(404, { error: "Instagram connection was not found." });
    if (client.integrations?.instagram?.review_publish_enabled !== true) {
      return json(403, { error: "Instagram publishing is not enabled for this business." });
    }
    if (body.reviewed !== true) {
      return json(400, { error: "Review and confirmation are required before publishing." });
    }
    if (typeof body.caption !== "string" || !body.caption.trim() || body.caption.length > 2200) {
      return json(400, { error: "Instagram caption must be between 1 and 2200 characters." });
    }
    if (typeof body.image_data_url !== "string" || !body.image_data_url) {
      return json(400, { error: "An approved Instagram image is required." });
    }

    const crypto = options.crypto ?? defaultCrypto();
    const store = options.store ?? instagramDatabase({ crypto });
    const current = now();
    let credential;
    try {
      credential = await store.readCredential({ businessId });
      if (!credential || credential.status !== "active") {
        return json(409, { code: "INSTAGRAM_RECONNECT_REQUIRED", error: "Reconnect Instagram before publishing." });
      }
      const expiresAt = new Date(credential.token_expires_at);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= current.getTime() + EXPIRY_SAFETY_MS) {
        return json(409, { code: "INSTAGRAM_RECONNECT_REQUIRED", error: "Reconnect Instagram before publishing." });
      }
    } catch {
      return json(503, { error: "GrowthWise could not read the Instagram connection." });
    }

    let payload;
    try {
      payload = crypto.decryptCredential({
        businessId,
        accountBindingKey: credential.account_binding_key,
        encryptedToken: credential.encrypted_credential,
      });
    } catch {
      return json(409, { code: "INSTAGRAM_RECONNECT_REQUIRED", error: "Reconnect Instagram before publishing." });
    }

    const accountId = payload?.account_id;
    const accessToken = payload?.access_token;
    const grantedScopes = scopes(payload?.scope);
    if (typeof accountId !== "string" || !accountId || typeof accessToken !== "string" || !accessToken) {
      return json(409, { code: "INSTAGRAM_RECONNECT_REQUIRED", error: "Reconnect Instagram before publishing." });
    }
    if (!grantedScopes.includes(INSTAGRAM_CONTENT_PUBLISH_SCOPE)) {
      return json(409, {
        code: "PUBLISHING_PERMISSION_REQUIRED",
        error: "Reconnect Instagram to approve publishing access, then try again.",
      });
    }

    const verifyIdentity = options.verifyIdentity
      ?? ((input) => verifyProfessionalIdentity({ ...input, fetchImpl: options.fetchImpl ?? fetch }));
    let identity;
    try { identity = await verifyIdentity({ accessToken }); }
    catch {
      return json(409, { code: "INSTAGRAM_RECONNECT_REQUIRED", error: "Reconnect Instagram before publishing." });
    }
    if (!identity || identity.accountId !== accountId) {
      return json(409, { code: "INSTAGRAM_RECONNECT_REQUIRED", error: "Reconnect Instagram before publishing." });
    }

    let staged;
    try {
      staged = await (options.stageImage ?? stageInstagramImage)({
        businessId,
        imageDataUrl: body.image_data_url,
        publicOrigin: requestUrl.origin,
        now: current,
      });
    } catch (error) {
      return json(400, { error: error?.message || "Instagram image could not be prepared." });
    }

    const graphApiVersion = options.graphApiVersion ?? configuredGraphVersion();
    let container;
    try {
      container = await (options.createContainer ?? createInstagramImageContainer)({
        accountId,
        accessToken,
        imageUrl: staged.publicUrl,
        caption: body.caption.trim(),
        graphApiVersion,
        fetchImpl: options.fetchImpl ?? fetch,
      });
    } catch (error) {
      try { logger.warn("instagram_publish_failed", { stage: "create_container", code: error?.code ?? "local_error" }); } catch {}
      const temporary = error instanceof InstagramPublishError && error.code === "temporarily_unavailable";
      return json(temporary ? 503 : 502, {
        code: "INSTAGRAM_PUBLISH_FAILED",
        error: temporary ? "Instagram is temporarily unavailable. No post was sent." : "Instagram could not prepare the post.",
        retry_safe: true,
      });
    }

    try {
      const published = await (options.publishContainer ?? publishInstagramContainer)({
        accountId,
        accessToken,
        containerId: container.containerId,
        graphApiVersion,
        fetchImpl: options.fetchImpl ?? fetch,
      });
      return json(200, {
        ok: true,
        published: true,
        live_sent: true,
        media_id: published.mediaId,
        account: { username: identity.username },
      });
    } catch (error) {
      try { logger.warn("instagram_publish_failed", { stage: "media_publish", code: error?.code ?? "local_error" }); } catch {}
      return json(502, {
        code: "INSTAGRAM_PUBLISH_AMBIGUOUS",
        error: "Instagram did not confirm the final publish. Check Instagram before trying again.",
        retry_safe: false,
      });
    }
  };
}

export default createInstagramPublishHandler();
