import test from "node:test";
import assert from "node:assert/strict";
import {
  isGrowthWiseDeployPreviewOrigin,
  squareOAuthConfigForRequest,
} from "../../netlify/functions/_square-oauth-config.mjs";

function env(values) {
  return (name) => values[name] || "";
}

test("Square sandbox OAuth binds to the exact GrowthWise deploy-preview request origin", () => {
  const origin = "https://deploy-preview-16--euphonious-beijinho-db4b4d.netlify.app";
  const settings = squareOAuthConfigForRequest(
    new URL(origin + "/.netlify/functions/square-oauth-start"),
    {
      env: env({
        GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT: "sandbox",
        GROWTHWISE_SQUARE_OAUTH_APPLICATION_ID: "fixture-app-id",
        GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-app-material-123456",
        GROWTHWISE_PUBLIC_ORIGIN: "https://example.invalid",
      }),
    },
  );

  assert.equal(settings.environment, "sandbox");
  assert.equal(settings.publicOrigin, origin);
  assert.equal(
    settings.callbackUri,
    origin + "/.netlify/functions/square-oauth-callback",
  );
});

test("untrusted hosts cannot become the Square OAuth public origin", () => {
  const settings = squareOAuthConfigForRequest(
    new URL("https://evil.example/.netlify/functions/square-oauth-start"),
    {
      env: env({
        GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT: "sandbox",
        GROWTHWISE_SQUARE_OAUTH_APPLICATION_ID: "fixture-app-id",
        GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-app-material-123456",
        GROWTHWISE_PUBLIC_ORIGIN: "https://safe.example",
      }),
    },
  );
  assert.equal(settings.publicOrigin, "https://safe.example");
});

test("production configuration never accepts a GrowthWise deploy-preview origin", () => {
  const origin = "https://deploy-preview-16--euphonious-beijinho-db4b4d.netlify.app";
  assert.throws(
    () => squareOAuthConfigForRequest(
      new URL(origin + "/.netlify/functions/square-oauth-start"),
      {
        env: env({
          GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT: "production",
          GROWTHWISE_SQUARE_OAUTH_APPLICATION_ID: "fixture-app-id",
          GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET: "fixture-app-material-123456",
          GROWTHWISE_PUBLIC_ORIGIN: origin,
        }),
      },
    ),
    /PRODUCTION_PREVIEW_FORBIDDEN/,
  );
});

test("deploy-preview origin recognizer is exact to the GrowthWise Netlify site", () => {
  assert.equal(isGrowthWiseDeployPreviewOrigin(
    "https://deploy-preview-16--euphonious-beijinho-db4b4d.netlify.app",
  ), true);
  assert.equal(isGrowthWiseDeployPreviewOrigin(
    "https://deploy-preview-16--other-site.netlify.app",
  ), false);
  assert.equal(isGrowthWiseDeployPreviewOrigin(
    "http://deploy-preview-16--euphonious-beijinho-db4b4d.netlify.app",
  ), false);
});
