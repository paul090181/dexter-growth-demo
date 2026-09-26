import { authorizePilotRequest } from "./_pilot-auth.mjs";
import { createPilotStore } from "./_pilot-store.mjs";
import { createInstagramPublishHandler } from "./instagram-publish.mjs";

const BUSINESS_ID = "dexters-hats";
const INTERNAL_AUTH = "dexter-connector-session-authorized";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createDexterInstagramPublishHandler({
  pilotStore = createPilotStore(),
  pilotAuthorize = authorizePilotRequest,
  innerHandler = createInstagramPublishHandler({ adminKey: () => INTERNAL_AUTH }),
} = {}) {
  return async function dexterInstagramPublish(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    const auth = await pilotAuthorize(request, {
      store: pilotStore,
      businessId: BUSINESS_ID,
      now: new Date(),
    });
    if (!auth?.ok || auth.businessId !== BUSINESS_ID) {
      return json(401, { error: "Dexter pilot session is invalid or expired." });
    }

    let text;
    let body;
    try {
      text = await request.text();
      body = JSON.parse(text);
    } catch {
      return json(400, { error: "Invalid publish request." });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || body.business_id !== BUSINESS_ID) {
      return json(403, { error: "This pilot can publish only for Dexter's Hats." });
    }

    const sourceUrl = new URL(request.url);
    const targetUrl = new URL("/.netlify/functions/instagram-publish", sourceUrl.origin);
    const headers = new Headers(request.headers);
    headers.set("content-type", "application/json");
    headers.set("x-growthwise-key", INTERNAL_AUTH);
    headers.delete("content-length");

    return innerHandler(new Request(targetUrl, {
      method: "POST",
      headers,
      body: text,
    }));
  };
}

export default createDexterInstagramPublishHandler();
