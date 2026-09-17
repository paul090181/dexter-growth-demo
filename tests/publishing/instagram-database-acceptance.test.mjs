import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInstagramDatabaseAcceptanceHandler } from "../../netlify/functions/instagram-database-acceptance.mjs";

const ADMIN = "synthetic-admin-key";
function request(method = "POST", key = ADMIN) {
  return new Request("https://preview.example/.netlify/functions/instagram-database-acceptance", {
    method, headers: key === undefined ? {} : { "x-growthwise-key": key },
  });
}
function handler(overrides = {}) {
  const values = { CONTEXT: "deploy-preview", GROWTHWISE_DATABASE_ACCEPTANCE_ENABLED: "yes", GROWTHWISE_ADMIN_KEY: ADMIN, ...overrides };
  return createInstagramDatabaseAcceptanceHandler({ env: name => values[name], run: async () => ({ ok: true, checks: [{ name: "migration_compatibility", status: "PASS" }] }) });
}

test("acceptance harness is invisible outside the exact deploy-preview context", async () => {
  for (const context of ["production", "branch-deploy", "dev", "", undefined]) {
    assert.equal((await handler({ CONTEXT: context })(request())).status, 404);
  }
});

test("acceptance harness requires POST, explicit enablement, and timing-safe admin authentication", async () => {
  const get = await handler()(request("GET"));
  assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await handler({ GROWTHWISE_DATABASE_ACCEPTANCE_ENABLED: "no" })(request())).status, 404);
  assert.equal((await handler()(new Request("https://preview.example/.netlify/functions/instagram-database-acceptance", { method: "POST" }))).status, 401);
  assert.equal((await handler()(request("POST", "wrong"))).status, 401);
  assert.equal((await handler()(request())).status, 200);
});

test("acceptance response is safe and has no CORS or backend error details", async () => {
  const secret = "postgres://database.example/token-secret";
  const failing = createInstagramDatabaseAcceptanceHandler({
    env: name => ({ CONTEXT: "deploy-preview", GROWTHWISE_DATABASE_ACCEPTANCE_ENABLED: "yes", GROWTHWISE_ADMIN_KEY: ADMIN })[name],
    run: async () => { throw new Error(`syntax error at SQL ${secret}`); },
  });
  const response = await failing(request()); const body = await response.text();
  assert.equal(response.status, 503);
  assert.equal(response.headers.has("access-control-allow-origin"), false);
  assert.doesNotMatch(body, /postgres:|token-secret|syntax error|SQL/i);
  assert.deepEqual(JSON.parse(body), { ok: false, checks: [{ name: "database_acceptance", status: "FAIL" }] });
});

test("runtime uses only synthetic prefixed rows and parameterized row-scoped cleanup", async () => {
  const source = await readFile(new URL("../../netlify/functions/instagram-database-acceptance.mjs", import.meta.url), "utf8");
  assert.match(source, /instagram-acceptance-\$\{randomUUID\(\)\}-/);
  assert.match(source, /DELETE FROM instagram_credentials WHERE business_id LIKE \$1/);
  assert.match(source, /DELETE FROM instagram_oauth_transactions WHERE transaction_key LIKE \$1/);
  assert.doesNotMatch(source, /\b(?:DROP|TRUNCATE|ALTER)\b/i);
  assert.doesNotMatch(source, /NETLIFY_DB_URL/);
});

test("temporary Android UI sends the typed key only as X-GrowthWise-Key and renders safe text", async () => {
  const html = await readFile(new URL("../../instagram-dev.html", import.meta.url), "utf8");
  assert.match(html, /TEMPORARY ACCEPTANCE HARNESS — REMOVE BEFORE MERGE/);
  assert.match(html, /instagram-database-acceptance/);
  assert.match(html, /headers: \{ "X-GrowthWise-Key": input\.value \}/);
  assert.match(html, /item\.textContent = `\$\{check\.name\}: \$\{check\.status\}`/);
  assert.doesNotMatch(html, /NETLIFY_DB_URL|postgres(?:ql)?:\/\//i);
});
