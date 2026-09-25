import { createHash } from "node:crypto";

function defaultEnv(name) {
  return globalThis.Netlify?.env?.get(name) || "";
}

function isDeployPreview(env) {
  const context = env("CONTEXT");
  if (context === "deploy-preview") return true;
  const prime = env("DEPLOY_PRIME_URL");
  try {
    return /^deploy-preview-\d+--/.test(new URL(prime).hostname);
  } catch {
    return false;
  }
}

function derive(root, label) {
  return createHash("sha256")
    .update("growthwise-square-preview-v1\n", "utf8")
    .update(label, "utf8")
    .update("\n", "utf8")
    .update(root, "utf8")
    .digest("base64url");
}

export function squareCryptoVersion(name, {
  env = defaultEnv,
} = {}) {
  const explicit = env(name);
  if (explicit) {
    return { current: { id: "v1", key: explicit } };
  }

  if (!isDeployPreview(env)) {
    return { current: { id: "v1", key: "" } };
  }

  const root = env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET");
  if (!root) {
    return { current: { id: "v1", key: "" } };
  }

  return {
    current: {
      id: "preview-derived-v1",
      key: derive(root, name),
    },
  };
}

export function previewAcceptanceKey({
  env = defaultEnv,
} = {}) {
  const explicit = env("GROWTHWISE_PREVIEW16_ACCEPTANCE_KEY");
  if (explicit) return explicit;
  if (!isDeployPreview(env)) return "";

  const root = env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET");
  if (!root) return "";
  return derive(root, "preview16-acceptance-key");
}
