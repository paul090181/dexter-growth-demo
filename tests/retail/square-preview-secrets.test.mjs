import test from "node:test";
import assert from "node:assert/strict";
import {
  previewAcceptanceKey,
  squareCryptoVersion,
} from "../../netlify/functions/_square-preview-secrets.mjs";

function env(values) {
  return (name) => values[name] || "";
}

test("explicit Square crypto configuration wins", () => {
  const version = squareCryptoVersion("GROWTHWISE_SQUARE_OAUTH_STATE_SECRET", {
    env: env({
      CONTEXT: "deploy-preview",
      GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-root-material-123456",
      GROWTHWISE_SQUARE_OAUTH_STATE_SECRET: "fixture-state-material-123456",
    }),
  });
  assert.deepEqual(version, {
    current: { id: "v1", key: "fixture-state-material-123456" },
  });
});

test("deploy previews derive stable separated Square crypto keys", () => {
  const read = env({
    CONTEXT: "deploy-preview",
    GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-root-material-123456",
  });

  const state = squareCryptoVersion("GROWTHWISE_SQUARE_OAUTH_STATE_SECRET", { env: read });
  const binding = squareCryptoVersion("GROWTHWISE_SQUARE_ACCOUNT_BINDING_SECRET", { env: read });
  const encryption = squareCryptoVersion("GROWTHWISE_SQUARE_CREDENTIAL_ENCRYPTION_KEY", { env: read });

  assert.equal(state.current.id, "preview-derived-v1");
  assert.equal(binding.current.id, "preview-derived-v1");
  assert.equal(encryption.current.id, "preview-derived-v1");
  assert.notEqual(state.current.key, binding.current.key);
  assert.notEqual(binding.current.key, encryption.current.key);
  assert.equal(Buffer.from(encryption.current.key, "base64url").length, 32);
});

test("production never derives Square crypto keys from fallback material", () => {
  const version = squareCryptoVersion("GROWTHWISE_SQUARE_OAUTH_STATE_SECRET", {
    env: env({
      CONTEXT: "production",
      GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-root-material-123456",
    }),
  });
  assert.equal(version.current.key, "");
});

test("Preview acceptance key derives only in deploy previews", () => {
  const preview = previewAcceptanceKey({
    env: env({
      CONTEXT: "deploy-preview",
      GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-root-material-123456",
    }),
  });
  const production = previewAcceptanceKey({
    env: env({
      CONTEXT: "production",
      GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-root-material-123456",
    }),
  });

  assert.match(preview, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(production, "");
});

test("explicit acceptance configuration wins in Preview", () => {
  assert.equal(previewAcceptanceKey({
    env: env({
      CONTEXT: "deploy-preview",
      GROWTHWISE_PREVIEW16_ACCEPTANCE_KEY: "fixture-acceptance-material",
      GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-root-material-123456",
    }),
  }), "fixture-acceptance-material");
});
