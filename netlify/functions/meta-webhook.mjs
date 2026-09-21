import { createInstagramCrypto } from "./_instagram-crypto.mjs";
import { INSTAGRAM_CLIENTS } from "./_instagram-clients.mjs";
import { instagramDatabase } from "./_instagram-store.mjs";
import { ingestRetailLead } from "./_retail-lead-ingest.mjs";
import {
  normalizeMetaWebhookPayload,
  parseMetaAccountMap,
  secureTextMatch,
  verifyMetaSignature,
} from "./_meta-webhook.mjs";

const MAX_BODY_BYTES = 1024 * 1024;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(status, body) {
  return new Response(String(body ?? ""), {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

function configuredEnv(name) {
  return globalThis.Netlify?.env?.get(name) ?? "";
}

function versions(env, name) {
  return { current: { id: "v1", key: env(name) } };
}

function configuredInstagramRouter(env) {
  const businessIds = Object.values(INSTAGRAM_CLIENTS)
    .filter((client) => client.messagesEnabled === true)
    .map((client) => client.business_id);
  if (!businessIds.length) return async () => null;
  const crypto = createInstagramCrypto({
    stateSecrets: versions(env, "GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET"),
    bindingSecrets: versions(env, "GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions(env, "GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY"),
  });
  const store = instagramDatabase({ crypto });
  return (accountId) => store.resolveBusinessByAccountId({ accountId, businessIds });
}

async function enrichInstagramAccountMap(payload, accountMap, routeInstagramBusiness) {
  if (payload?.object !== "instagram" || typeof routeInstagramBusiness !== "function") return accountMap;
  const instagram = { ...(accountMap.instagram || {}) };
  const accountIds = [...new Set((Array.isArray(payload.entry) ? payload.entry : [])
    .map((entry) => String(entry?.id ?? "").trim())
    .filter(Boolean))];
  for (const accountId of accountIds) {
    if (instagram[accountId]) continue;
    const businessId = await routeInstagramBusiness(accountId);
    if (businessId) instagram[accountId] = businessId;
  }
  return { ...accountMap, instagram };
}

export function createMetaWebhookHandler({
  env = configuredEnv,
  ingest = (input) => ingestRetailLead(input, { ingestionTag: "meta_webhook" }),
  routeInstagramBusiness,
  logger = console,
} = {}) {
  return async function metaWebhookHandler(request) {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const mode = url.searchParams.get("hub.mode") || "";
      const suppliedToken = url.searchParams.get("hub.verify_token") || "";
      const challenge = url.searchParams.get("hub.challenge") || "";
      const expectedToken = env("META_WEBHOOK_VERIFY_TOKEN") || "";
      if (!expectedToken) return text(503, "Webhook verification is not configured.");
      if (mode !== "subscribe" || !challenge || !secureTextMatch(suppliedToken, expectedToken)) {
        return text(403, "Webhook verification failed.");
      }
      return text(200, challenge);
    }

    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    const appSecret = env("META_APP_SECRET") || env("GROWTHWISE_INSTAGRAM_APP_SECRET") || "";
    if (!appSecret) return json(503, { error: "Meta webhook signature verification is not configured." });

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return json(413, { error: "Meta webhook payload is too large." });
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: "Meta webhook payload is too large." });
    }
    if (!verifyMetaSignature({
      rawBody,
      signature: request.headers.get("x-hub-signature-256") || "",
      appSecret,
    })) {
      return json(401, { error: "Invalid Meta webhook signature." });
    }

    let payload;
    try { payload = JSON.parse(rawBody); }
    catch { return json(400, { error: "Invalid Meta webhook JSON." }); }

    let accountMap;
    try {
      accountMap = parseMetaAccountMap(env("GROWTHWISE_META_ACCOUNT_MAP") || "");
      if (payload?.object === "instagram") {
        const instagramRouter = routeInstagramBusiness ?? configuredInstagramRouter(env);
        accountMap = await enrichInstagramAccountMap(payload, accountMap, instagramRouter);
      }
    } catch {
      return json(503, { error: "Meta account routing is not configured correctly." });
    }

    const normalized = normalizeMetaWebhookPayload(payload, { accountMap });
    if (normalized.unrouted.length) {
      try {
        logger.warn("meta_webhook_unrouted", {
          count: normalized.unrouted.length,
          source_types: [...new Set(normalized.unrouted.map((item) => item.source_type))],
        });
      } catch {}
      return json(503, {
        error: "Meta delivered a message for an account that is not mapped to a GrowthWise business.",
        unrouted: normalized.unrouted.length,
      });
    }

    let inserted = 0;
    let duplicates = 0;
    for (const event of normalized.events) {
      const result = await ingest(event);
      if (result?.duplicate) duplicates += 1;
      else inserted += 1;
    }

    try {
      logger.info("meta_webhook_processed", {
        events: normalized.events.length,
        inserted,
        duplicates,
        ignored: normalized.ignored,
      });
    } catch {}

    return json(200, {
      ok: true,
      received: normalized.events.length,
      inserted,
      duplicates,
      ignored: normalized.ignored,
    });
  };
}

export default createMetaWebhookHandler();
