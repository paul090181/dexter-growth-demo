import { authorizePilotRequest } from "./_pilot-auth.mjs";
import { createPilotStore } from "./_pilot-store.mjs";
import { getInstagramClient } from "./_instagram-clients.mjs";
import { createInstagramOAuthStartHandler } from "./instagram-oauth-start.mjs";

const BUSINESS_ID = "dexters-hats";
const INTERNAL_AUTH = "dexter-pilot-session-authorized";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function pilotClient(businessId) {
  if (businessId !== BUSINESS_ID) throw new Error("Invalid pilot business.");
  const client = getInstagramClient(BUSINESS_ID);
  return Object.freeze({ ...client, returnDestinationId: "dexter-pilot-integration" });
}

export function createDexterInstagramOAuthStartHandler({
  pilotStore = createPilotStore(),
  pilotAuthorize = authorizePilotRequest,
  innerFactory = createInstagramOAuthStartHandler,
} = {}) {
  return async function dexterInstagramOAuthStart(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const auth = await pilotAuthorize(request, { store: pilotStore, businessId: BUSINESS_ID, now: new Date() });
    if (!auth?.ok || auth.businessId !== BUSINESS_ID) {
      return json(401, { error: "Dexter pilot session is invalid or expired." });
    }

    const source = new URL(request.url);
    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid request." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || body.business_id !== BUSINESS_ID) {
      return json(400, { error: "Invalid request." });
    }

    const inner = innerFactory({
      adminKey: () => INTERNAL_AUTH,
      publicOrigin: () => source.origin,
      getClient: pilotClient,
    });
    const target = new URL("/.netlify/functions/instagram-oauth-start", source.origin);
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("origin", source.origin);
    headers.set("sec-fetch-site", "same-origin");
    headers.set("x-growthwise-key", INTERNAL_AUTH);
    return inner(new Request(target, {
      method: "POST",
      headers,
      body: JSON.stringify({ business_id: BUSINESS_ID }),
    }));
  };
}

export default createDexterInstagramOAuthStartHandler();
