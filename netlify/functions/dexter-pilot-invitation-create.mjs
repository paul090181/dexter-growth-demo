import { authorized } from "./_lead-store.mjs";
import { generatePilotInvitationToken, hashPilotToken } from "./_pilot-auth.mjs";
import { createPilotStore } from "./_pilot-store.mjs";

const BUSINESS_ID = "dexters-hats";
const INVITE_TTL_MS = 72 * 60 * 60 * 1000;
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

function previewOrigin(request) {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:" || !PREVIEW_HOST.test(url.hostname)
      || url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function createDexterPilotInvitationCreateHandler({
  isAuthorized = authorized,
  store = createPilotStore(),
  now = () => new Date(),
  tokenFactory = generatePilotInvitationToken,
} = {}) {
  return async function dexterPilotInvitationCreate(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });
    const origin = previewOrigin(request);
    if (!origin) return json(404, { error: "Pilot invitations are not available here." });
    if (!isAuthorized(request)?.ok) return json(401, { error: "Unauthorized." });

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid request." }); }
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).length !== 1 || body.business_id !== BUSINESS_ID) {
      return json(400, { error: "Invalid pilot business." });
    }

    const createdAt = now();
    const expiresAt = new Date(createdAt.getTime() + INVITE_TTL_MS);
    const rawToken = tokenFactory();
    try {
      await store.createInvitation({
        invitationHash: hashPilotToken(rawToken),
        businessId: BUSINESS_ID,
        expiresAt,
      });
    } catch {
      return json(503, { error: "Pilot invitation could not be created." });
    }

    const url = new URL("/dexter-pilot.html", origin);
    url.hash = `invite=${rawToken}`;
    return json(201, {
      business_id: BUSINESS_ID,
      expires_at: expiresAt.toISOString(),
      invitation_url: url.toString(),
    });
  };
}

export default function handler(request) {
  return createDexterPilotInvitationCreateHandler()(request);
}
