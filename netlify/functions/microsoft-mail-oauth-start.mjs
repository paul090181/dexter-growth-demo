import { createMicrosoftMailCrypto } from "./_microsoft-mail-crypto.mjs";
import { createMicrosoftMailStore } from "./_microsoft-mail-store.mjs";
import {
  MICROSOFT_MAIL_SCOPES,
  buildMicrosoftMailAuthorizationUrl,
  configuredMicrosoftMailOAuth,
} from "./_microsoft-mail-oauth.mjs";
import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { canonicalOrigin, connectorJson, exactKeys, readConnectorJson } from "./_connector-http.mjs";

const PATH = "/.netlify/functions/microsoft-mail-oauth-start";
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

function env(name) { return globalThis.Netlify?.env?.get(name); }
function versions(name) { return { current: { id: "v1", key: env(name) } }; }

function defaultCrypto() {
  return createMicrosoftMailCrypto({
    stateSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET"),
    bindingSecrets: versions("GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET"),
    credentialKeys: versions("GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

const recentStarts = new Map();
const defaultRateLimiter = {
  consume({ businessId, now }) {
    const previous = recentStarts.get(businessId);
    if (previous && now.getTime() - previous < 30_000) return false;
    recentStarts.set(businessId, now.getTime());
    return true;
  },
};

function validateAuthorizationUrl(value, expected) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== "https://login.microsoftonline.com"
    || url.pathname !== "/common/oauth2/v2.0/authorize"
    || url.username || url.password || url.hash) {
    throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  const required = {
    client_id: expected.clientId,
    response_type: "code",
    redirect_uri: expected.callbackUri,
    response_mode: "query",
    scope: MICROSOFT_MAIL_SCOPES.join(" "),
    state: expected.state,
    prompt: "select_account",
  };
  if ([...url.searchParams].length !== Object.keys(required).length) {
    throw new Error("UNSAFE_AUTHORIZATION_URL");
  }
  for (const [key, wanted] of Object.entries(required)) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== wanted) {
      throw new Error("UNSAFE_AUTHORIZATION_URL");
    }
  }
  return url;
}

export function createMicrosoftMailOAuthStartHandler(options = {}) {
  const connectorStore = options.connectorStore ?? createConnectorStore();
  const connectorAuthorize = options.connectorAuthorize ?? authorizeConnectorRequest;
  const config = options.config ?? (() => configuredMicrosoftMailOAuth());
  const now = options.now ?? (() => new Date());
  const rateLimiter = options.rateLimiter ?? defaultRateLimiter;

  return async function microsoftMailOAuthStart(request) {
    if (request.method !== "POST") {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "POST" });
    }

    let settings;
    let configuredOrigin;
    let requestUrl;
    try {
      settings = config();
      configuredOrigin = canonicalOrigin(settings.publicOrigin);
      requestUrl = new URL(request.url);
    } catch {
      return connectorJson(503, { error: "Microsoft email connection is not configured." });
    }

    if (requestUrl.origin !== configuredOrigin
      || requestUrl.pathname !== PATH
      || requestUrl.search
      || requestUrl.hash
      || request.headers.get("origin") !== configuredOrigin
      || (request.headers.get("sec-fetch-site") !== null
        && request.headers.get("sec-fetch-site") !== "same-origin")) {
      return connectorJson(403, { error: "Request origin was rejected." });
    }

    let body;
    try { body = await readConnectorJson(request); }
    catch { return connectorJson(400, { error: "Invalid request." }); }

    if (!exactKeys(body, ["business_id", "mailbox_context"])
      || typeof body.business_id !== "string"
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(body.business_id)
      || !["business", "personal_acknowledged"].includes(body.mailbox_context)) {
      return connectorJson(400, { error: "Invalid request." });
    }

    const startedAt = now();
    const auth = await connectorAuthorize(request, {
      store: connectorStore,
      businessId: body.business_id,
      connector: "email",
      now: startedAt,
    });
    if (!auth?.ok || auth.businessId !== body.business_id) {
      return connectorJson(401, { error: "Session is invalid or expired." });
    }

    let allowed = false;
    try { allowed = await rateLimiter.consume({ businessId: body.business_id, now: startedAt }); }
    catch {}
    if (!allowed) {
      return connectorJson(429, { error: "Try connecting email again later." });
    }

    try {
      const crypto = options.crypto ?? defaultCrypto();
      const store = options.store ?? createMicrosoftMailStore({ crypto });
      const { state } = await store.createTransactionWithFreshState({
        createState: () => crypto.createState(),
        businessId: body.business_id,
        mailboxContext: body.mailbox_context,
        expiresAt: new Date(startedAt.getTime() + TRANSACTION_TTL_MS),
      });

      const authorizationUrl = (options.buildUrl ?? buildMicrosoftMailAuthorizationUrl)({
        clientId: settings.clientId,
        callbackUri: settings.callbackUri,
        state,
      });
      const safe = validateAuthorizationUrl(authorizationUrl, {
        clientId: settings.clientId,
        callbackUri: settings.callbackUri,
        state,
      });
      return connectorJson(200, { authorization_url: safe.toString() });
    } catch {
      return connectorJson(503, { error: "Microsoft email connection could not be started." });
    }
  };
}

export default createMicrosoftMailOAuthStartHandler();
