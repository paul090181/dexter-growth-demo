import assert from "node:assert/strict";
import test from "node:test";

import { resolveGrowthWisePublicOrigin } from "../../netlify/functions/_public-origin.mjs";

test("deploy-specific Netlify origin wins over a shared configured preview origin", () => {
  const values = {
    DEPLOY_PRIME_URL: "https://deploy-preview-15--euphonious-beijinho-db4b4d.netlify.app",
    GROWTHWISE_PUBLIC_ORIGIN: "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app",
  };
  assert.equal(
    resolveGrowthWisePublicOrigin((name) => values[name] || ""),
    values.DEPLOY_PRIME_URL,
  );
});

test("configured origin remains a safe fallback when deploy origin is unavailable", () => {
  const values = {
    GROWTHWISE_PUBLIC_ORIGIN: "https://preview.example",
  };
  assert.equal(
    resolveGrowthWisePublicOrigin((name) => values[name] || ""),
    values.GROWTHWISE_PUBLIC_ORIGIN,
  );
});

test("invalid or insecure origins fail closed", () => {
  const values = {
    DEPLOY_PRIME_URL: "http://preview.example",
    GROWTHWISE_PUBLIC_ORIGIN: "not-a-url",
  };
  assert.equal(resolveGrowthWisePublicOrigin((name) => values[name] || ""), "");
});
