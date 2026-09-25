import { createHash } from "node:crypto";

function defaultEnv(name) {
  return globalThis.Netlify?.env?.get(name) || "";
}

function previewRoot(env) {
  if (env("GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT") !== "sandbox") return "";
  return env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET") || "";
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

  const root = previewRoot(env);
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

  const root = previewRoot(env);
  if (!root) return "";
  return derive(root, "preview16-acceptance-key");
}
