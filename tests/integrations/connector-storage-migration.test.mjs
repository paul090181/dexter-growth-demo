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
