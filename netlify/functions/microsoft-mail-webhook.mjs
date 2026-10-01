import { createHmac } from "node:crypto";

const PATH = "/.netlify/functions/microsoft-mail-webhook";
const BACKGROUND_PATH = "/.netlify/functions/microsoft-mail-process-background";
const MAX_BODY_BYTES = 192 * 1024;
const MAX_VALIDATION_TOKEN = 4096;

function env(name) { return globalThis.Netlify?.env?.get(name); }

function safeHeaders(extra = {}) {
  return {
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...extra,
  };
}

function dispatchSignature(body, secret) {
  if (typeof secret !== "string" || secret.length < 16) {
    throw new Error("WEBHOOK_NOT_CONFIGURED");
  }
  return createHmac("sha256", secret)
    .update("growthwise-microsoft-mail-dispatch-v1\n", "utf8")
    .update(body, "utf8")
    .digest("hex");
}

async function readBoundedBody(request) {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new Error("REQUEST_TOO_LARGE");
  }
  return text;
}

function validationResponse(url) {
  const tokens = url.searchParams.getAll("validationToken");
  if (url.searchParams.size !== 1 || tokens.length !== 1) return null;
  const token = tokens[0];
  if (!token || token.length > MAX_VALIDATION_TOKEN || /[\r\n]/.test(token)) {
    return new Response("Invalid validation token.", {
      status: 400,
      headers: safeHeaders({ "content-type": "text/plain; charset=utf-8" }),
    });
  }
  return new Response(token, {
    status: 200,
    headers: safeHeaders({ "content-type": "text/plain; charset=utf-8" }),
  });
}

export function createMicrosoftMailWebhookHandler({
  publicOrigin = () => env("GROWTHWISE_PUBLIC_ORIGIN"),
  dispatchSecret = () => env("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
  fetchImpl = globalThis.fetch,
} = {}) {
  return async function microsoftMailWebhook(request) {
    if (request.method !== "POST") {
      return new Response("Method not allowed.", {
        status: 405,
        headers: safeHeaders({ allow: "POST" }),
      });
    }

    let url;
    let origin;
    try {
      url = new URL(request.url);
      origin = new URL(publicOrigin());
      if (origin.protocol !== "https:" || origin.origin !== publicOrigin()
        || origin.pathname !== "/" || origin.search || origin.hash
        || url.origin !== origin.origin || url.pathname !== PATH || url.hash) {
        throw new Error("INVALID_ORIGIN");
      }
    } catch {
      return new Response("Webhook unavailable.", {
        status: 503,
        headers: safeHeaders(),
      });
    }

    if (url.searchParams.has("validationToken")) {
      return validationResponse(url) ?? new Response("Invalid validation request.", {
        status: 400,
        headers: safeHeaders(),
      });
    }
    if (url.search) {
      return new Response("Invalid request.", { status: 400, headers: safeHeaders() });
    }

    let body;
    try {
      body = await readBoundedBody(request);
      const parsed = JSON.parse(body);
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.value)
        || parsed.value.length === 0 || parsed.value.length > 100) {
        throw new Error("INVALID_NOTIFICATION");
      }
    } catch {
      return new Response("Invalid request.", { status: 400, headers: safeHeaders() });
    }

    let signature;
    try { signature = dispatchSignature(body, dispatchSecret()); }
    catch {
      return new Response("Webhook unavailable.", { status: 503, headers: safeHeaders() });
    }

    let dispatch;
    try {
      dispatch = await fetchImpl(`${origin.origin}${BACKGROUND_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-growthwise-dispatch-signature": signature,
        },
        body,
      });
    } catch {
      return new Response("Dispatch unavailable.", { status: 503, headers: safeHeaders() });
    }

    if (dispatch.status !== 202) {
      return new Response("Dispatch unavailable.", { status: 503, headers: safeHeaders() });
    }
    return new Response(null, { status: 202, headers: safeHeaders() });
  };
}

export default createMicrosoftMailWebhookHandler();
