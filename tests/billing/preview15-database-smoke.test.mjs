import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../netlify/functions/preview15-database-smoke.mjs", import.meta.url),
  "utf8",
);

test("database smoke endpoint is hard-limited to Deploy Preview 15", () => {
  assert.match(source, /context === "deploy-preview"/);
  assert.match(source, /deploy-preview-15--/);
  assert.match(source, /return json\(404/);
});

test("database smoke test uses a transaction and always rolls back its synthetic row", () => {
  assert.match(source, /query\("BEGIN"\)/);
  assert.match(source, /growthwise_acquisition_attribution/);
  assert.match(source, /plan_started_at/);
  assert.match(source, /query\("ROLLBACK"\)/);
  assert.match(source, /persisted_test_rows:\s*0/);
});
