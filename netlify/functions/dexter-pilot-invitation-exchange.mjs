import {
  PILOT_SESSION_COOKIE,
  generatePilotSessionToken,
  hashPilotToken,
  pilotInvitationTokenPattern,
} from "./_pilot-auth.mjs";
import { createPilotStore } from "./_pilot-store.mjs";

const BUSINESS_ID = "dexters-hats";
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const PREVIEW_HOST = /^deploy-preview-\d+--euphonious-beijinho-db4b4d\.netlify\.app$/;
const CLEAR_COOKIE = `${PILOT_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      ...headers,
    },
  });
}

function validPreviewRequest(request) {
  try {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    return url.protocol === "https:"
      && PREVIEW_HOST.test(url.hostname)
      && url.pathname === "/.netlify/functions/dexter-pilot-invitation-exchange"
      && !url.search && !url.hash && !url.username && !url.password
      && origin === url.origin;
  } catch {
    return false;
  }
}

export function createDexterPilotInvitationExchangeHandler({
  store = createPilotStore(),
  now = () => new Date(),
  sessionTokenFactory = generatePilotSessionToken,
} = {}) {
  return async function dexterPilotInvitationExchange(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    if (!validPreviewRequest(request)) {
      return json(404, { error: "Pilot access is not available here." }, { "set-cookie": CLEAR_COOKIE });
    }

    let body;
    try { body = await request.json(); }
    catch { return json(401, { error: "This pilot link is invalid or expired." }, { "set-cookie": CLEAR_COOKIE }); }
    const token = body && typeof body === "object" && !Array.isArray(body)
      && Object.keys(body).length === 1
      && pilotInvitationTokenPattern.test(String(body.invitation_token || ""))
      ? body.invitation_token : "";
    if (!token) return json(401, { error: "This pilot link is invalid or expired." }, { "set-cookie": CLEAR_COOKIE });

    const rawSession = sessionTokenFactory();
    let session;
    try {
      session = await store.redeemInvitation({
        invitationHash: hashPilotToken(token),
        sessionHash: hashPilotToken(rawSession),
        now: now(),
      });
    } catch {
      return json(401, { error: "This pilot link is invalid or expired." }, { "set-cookie": CLEAR_COOKIE });
    }
    if (session.business_id !== BUSINESS_ID) {
      return json(401, { error: "This pilot link is invalid or expired." }, { "set-cookie": CLEAR_COOKIE });
    }

    return json(200, {
      ok: true,
      business_id: BUSINESS_ID,
      expires_at: new Date(session.expires_at).toISOString(),
    }, {
      "set-cookie": `${PILOT_SESSION_COOKIE}=${rawSession}; Max-Age=${MAX_AGE_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    });
  };
}

export default function handler(request) {
  return createDexterPilotInvitationExchangeHandler()(request);
}
