const PREVIEW_HOST_PATTERN = /^deploy-preview-\d+--euphonious-beijinho-db4b4d\.netlify\.app$/;

function safeHttpsOrigin(value) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  try {
    const url = new URL(clean);
    if (url.protocol === "https:"
      && url.origin === clean
      && !url.username
      && !url.password
      && !url.pathname.replaceAll("/", "")
      && !url.search
      && !url.hash) {
      return url.origin;
    }
  } catch {}
  return "";
}

function safePreviewOrigin(requestUrl) {
  if (!requestUrl) return "";
  try {
    const url = new URL(String(requestUrl));
    if (url.protocol === "https:"
      && !url.username
      && !url.password
      && PREVIEW_HOST_PATTERN.test(url.hostname)) {
      return url.origin;
    }
  } catch {}
  return "";
}

export function resolveGrowthWisePublicOrigin(
  get = (name) => Netlify.env.get(name) || "",
  requestUrl = "",
) {
  const deployOrigin = safeHttpsOrigin(get("DEPLOY_PRIME_URL"));
  if (deployOrigin) return deployOrigin;

  const requestPreviewOrigin = safePreviewOrigin(requestUrl);
  if (requestPreviewOrigin) return requestPreviewOrigin;

  return safeHttpsOrigin(get("GROWTHWISE_PUBLIC_ORIGIN"));
}
