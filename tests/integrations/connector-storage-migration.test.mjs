import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("connector storage migration allows email for invitations and sessions", async () => {
  const sql = await readFile(new URL(
    "../../netlify/database/migrations/20260924013000_connector-email-constraint/migration.sql",
    import.meta.url,
  ), "utf8");

  assert.match(sql, /growthwise_connector_invitations/);
  assert.match(sql, /growthwise_connector_sessions/);
  assert.match(sql, /cardinality\(connectors\) BETWEEN 1 AND 3/);
  assert.match(sql, /ARRAY\['email', 'facebook', 'instagram'\]::TEXT\[\]/);
  assert.match(sql, /growthwise_connector_invitations_connectors_allowed/);
  assert.match(sql, /growthwise_connector_sessions_connectors_allowed/);
});

test("application and database connector allowlists stay aligned", async () => {
  const store = await readFile(new URL(
    "../../netlify/functions/_connector-store.mjs",
    import.meta.url,
  ), "utf8");
  const create = await readFile(new URL(
    "../../netlify/functions/connector-invitation-create.mjs",
    import.meta.url,
  ), "utf8");
  const sql = await readFile(new URL(
    "../../netlify/database/migrations/20260924013000_connector-email-constraint/migration.sql",
    import.meta.url,
  ), "utf8");

  for (const connector of ["email", "facebook", "instagram"]) {
    assert.match(store, new RegExp(`["']${connector}["']`));
    assert.match(create, new RegExp(`["']${connector}["']`));
    assert.match(sql, new RegExp(`'${connector}'`));
  }
});


test("website connector migration expands connector allowlists and creates a stable public form id", async () => {
  const sql = await readFile(new URL(
    "../../netlify/database/migrations/20260927200000_website-lead-forms/migration.sql",
    import.meta.url,
  ), "utf8");

  assert.match(sql, /growthwise_connector_invitations/);
  assert.match(sql, /growthwise_connector_sessions/);
  assert.match(sql, /cardinality\(connectors\) BETWEEN 1 AND 4/);
  assert.match(sql, /ARRAY\['email', 'facebook', 'instagram', 'website'\]::TEXT\[\]/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS growthwise_website_forms/);
  assert.match(sql, /form_id TEXT NOT NULL UNIQUE/);
  assert.match(sql, /REFERENCES growthwise_tenants\(business_id\) ON DELETE CASCADE/);
});

test("current application connector allowlists include hosted website forms", async () => {
  const store = await readFile(new URL(
    "../../netlify/functions/_connector-store.mjs",
    import.meta.url,
  ), "utf8");
  const create = await readFile(new URL(
    "../../netlify/functions/connector-invitation-create.mjs",
    import.meta.url,
  ), "utf8");
  const tenantStart = await readFile(new URL(
    "../../netlify/functions/tenant-connector-session-start.mjs",
    import.meta.url,
  ), "utf8");

  for (const connector of ["email", "facebook", "instagram", "website"]) {
    assert.match(store, new RegExp(`["']${connector}["']`));
    assert.match(create, new RegExp(`["']${connector}["']`));
    assert.match(tenantStart, new RegExp(`["']${connector}["']`));
  }
});
