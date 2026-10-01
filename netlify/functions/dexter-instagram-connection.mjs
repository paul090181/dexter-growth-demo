import { authorizePilotRequest } from "./_pilot-auth.mjs";
import { createPilotStore } from "./_pilot-store.mjs";
import { createInstagramConnectionHandler } from "./instagram-connection.mjs";

const BUSINESS_ID = "dexters-hats";
const INTERNAL_AUTH = "dexter-pilot-session-authorized";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function createDexterInstagramConnectionHandler({
  pilotStore = createPilotStore(),
  pilotAuthorize = authorizePilotRequest,
  innerHandler = createInstagramConnectionHandler({ adminKey: () => INTERNAL_AUTH }),
} = {}) {
  return async function dexterInstagramConnection(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });
    const auth = await pilotAuthorize(request, { store: pilotStore, businessId: BUSINESS_ID, now: new Date() });
    if (!auth?.ok || auth.businessId !== BUSINESS_ID) {
      return json(401, { error: "Dexter pilot session is invalid or expired." });
    }

    const source = new URL(request.url);
    const target = new URL("/.netlify/functions/instagram-connection", source.origin);
    target.searchParams.set("business_id", BUSINESS_ID);
    const headers = new Headers(request.headers);
    headers.set("x-growthwise-key", INTERNAL_AUTH);
    return innerHandler(new Request(target, { method: "GET", headers }));
  };
}

export default createDexterInstagramConnectionHandler();
