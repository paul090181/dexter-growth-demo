import {
  generateTenantLoginToken,
  hashTenantLoginToken,
} from "./_tenant-auth.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";
import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import {
  configuredTransactionalEmail,
  sendTenantMagicLinks,
} from "./_transactional-email.mjs";

const TOKEN_TTL_MS = 15 * 60 * 1000;

function configuredOrigin(requestUrl = "") {
  return resolveGrowthWisePublicOrigin(undefined, requestUrl);
}

function normalizedEmail(value) {
  const clean = typeof value === "string" ? value.trim().toLowerCase() : "";
  return clean && clean.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean) ? clean : "";
}

function minuteBucket(date) {
  const bucket = new Date(date);
  bucket.setUTCSeconds(0, 0);
  return bucket;
}

export function createTenantLoginRequestHandler(options = {}) {
  const store = options.store ?? createTenantStore();
  const emailConfig = options.emailConfig ?? configuredTransactionalEmail;
  const sendEmail = options.sendEmail ?? sendTenantMagicLinks;
  const publicOrigin = options.publicOrigin ?? configuredOrigin;
  const now = options.now ?? (() => new Date());

  return async function tenantLoginRequest(request) {
    if (request.method !== "POST") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    }

    let origin;
    let requestUrl;
    try {
      origin = canonicalOrigin(publicOrigin(request.url));
      requestUrl = new URL(request.url);
    } catch {
      return connectorJson(503, { error: "Email sign-in is unavailable." });
    }

    const fetchSite = request.headers.get("sec-fetch-site");
    if (requestUrl.origin !== origin
      || requestUrl.pathname !== "/.netlify/functions/tenant-login-request"
      || requestUrl.search
      || requestUrl.hash
      || request.headers.get("origin") !== origin
      || (fetchSite !== null && fetchSite !== "same-origin")) {
      return connectorJson(403, { error: "Request origin was rejected." });
    }

    const config = emailConfig();
    if (!config) {
      return connectorJson(503, { error: "Email sign-in is not configured on this preview." });
    }

    let body;
    try { body = await readConnectorJson(request); }
    catch { return connectorJson(400, { error: "Enter a valid email address." }); }

    if (!exactKeys(body, ["email"])) {
      return connectorJson(400, { error: "Enter a valid email address." });
    }

    const email = normalizedEmail(body.email);
    if (!email) return connectorJson(400, { error: "Enter a valid email address." });

    let tenants = [];
    try {
      tenants = await store.listTenantsByEmail({ email });
    } catch {
      return connectorJson(200, {
        ok: true,
        message: "If that email belongs to a GrowthWise workspace, a secure sign-in link will arrive shortly.",
      });
    }

    const requestedAt = now();
    const requestBucket = minuteBucket(requestedAt);
    const expiresAt = new Date(requestedAt.getTime() + TOKEN_TTL_MS);
    const links = [];

    for (const tenant of tenants || []) {
      const rawToken = generateTenantLoginToken();
      let row = null;
      try {
        row = await store.createLoginToken({
          tokenHash: hashTenantLoginToken(rawToken),
          businessId: tenant.business_id,
          requestBucket,
          expiresAt,
        });
      } catch {}
      if (!row) continue;

      const link = new URL("/signin.html", origin);
      link.hash = `token=${rawToken}`;
      links.push({
        businessName: tenant.business_name,
        url: link.toString(),
      });
    }

    if (links.length > 0) {
      try {
        await sendEmail({ config, to: email, links });
      } catch {
        // Preserve the same public response so account existence cannot be inferred.
      }
    }

    return connectorJson(200, {
      ok: true,
      message: "If that email belongs to a GrowthWise workspace, a secure sign-in link will arrive shortly.",
    });
  };
}

export default function handler(request) {
  return createTenantLoginRequestHandler()(request);
}
