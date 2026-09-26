import { authorizePilotRequest } from "./_pilot-auth.mjs";
import { createPilotStore } from "./_pilot-store.mjs";

const BUSINESS_ID = "dexters-hats";
const PREVIEW_HOST = /^deploy-preview-\d+--euphonious-beijinho-db4b4d\.netlify\.app$/;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

export function createDexterPilotSessionHandler({
  store = createPilotStore(),
  now = () => new Date(),
} = {}) {
  return async function dexterPilotSession(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });
    let url;
    try { url = new URL(request.url); }
    catch { return json(400, { error: "Invalid request." }); }
    if (url.protocol !== "https:" || !PREVIEW_HOST.test(url.hostname)
      || url.pathname !== "/.netlify/functions/dexter-pilot-session"
      || url.search || url.hash) {
      return json(404, { error: "Pilot access is not available here." });
    }

    const auth = await authorizePilotRequest(request, {
      store,
      businessId: BUSINESS_ID,
      now: now(),
    });
    if (!auth.ok || auth.businessId !== BUSINESS_ID) {
      return json(401, { error: "Pilot session is invalid or expired." });
    }
    return json(200, {
      ok: true,
      business_id: BUSINESS_ID,
      business_name: "Dexter's Hats",
      expires_at: new Date(auth.expiresAt).toISOString(),
    });
  };
}

export default function handler(request) {
  return createDexterPilotSessionHandler()(request);
}
