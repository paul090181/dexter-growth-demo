import { resolveGrowthWisePublicOrigin } from "./_public-origin.mjs";
import { configuredSquareOAuth } from "./_square-oauth.mjs";

const PREVIEW_HOST = /^deploy-preview-\d+--euphonious-beijinho-db4b4d\.netlify\.app$/;

function defaultEnv(name) {
  return globalThis.Netlify?.env?.get(name) || "";
}

function safeRequestOrigin(requestUrl) {
  try {
    const url = requestUrl instanceof URL ? requestUrl : new URL(requestUrl);
    if (url.protocol !== "https:"
      || !PREVIEW_HOST.test(url.hostname)
      || url.username
      || url.password) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

export function squareOAuthConfigForRequest(requestUrl, {
  env = defaultEnv,
} = {}) {
  const environment = String(env("GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT") || "").trim();

  let publicOrigin = "";
  if (environment === "sandbox") {
    publicOrigin = safeRequestOrigin(requestUrl);
  }

  if (!publicOrigin) {
    publicOrigin = resolveGrowthWisePublicOrigin((name) => env(name) || "");
  }

  if (!publicOrigin) throw new Error("INVALID_ORIGIN");

  const settings = configuredSquareOAuth({ env, publicOrigin });

  if (settings.environment === "production"
    && PREVIEW_HOST.test(new URL(settings.publicOrigin).hostname)) {
    throw new Error("PRODUCTION_PREVIEW_FORBIDDEN");
  }

  return settings;
}

export function isGrowthWiseDeployPreviewOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.origin === value
      && PREVIEW_HOST.test(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}
