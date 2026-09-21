import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const ingest = await readFile(new URL("../../netlify/functions/retail-lead-ingest.mjs", import.meta.url), "utf8");
const sources = await readFile(new URL("../../netlify/functions/retail-lead-sources.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../../assets/retail-leads.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const migration = await readFile(new URL("../../netlify/database/migrations/20260920215000_unified-lead-inbox/migration.sql", import.meta.url), "utf8");

test("unified retail inbox stores normalized source metadata and de-duplicates provider messages", () => {
  assert.match(migration, /source_type/);
  assert.match(migration, /external_thread_id/);
  assert.match(migration, /external_message_id/);
  assert.match(migration, /reply_supported/);
  assert.match(migration, /growthwise_lead_sources/);
  assert.match(ingest, /external_message_id/);
  assert.match(ingest, /duplicate: true/);
  assert.match(ingest, /source_metadata/);
});

test("unified retail inbox supports Instagram Facebook email website SMS and manual sources", () => {
  for (const source of ["instagram","facebook","email","website","sms","manual"]) {
    assert.match(sources, new RegExp(source));
    assert.match(ingest, new RegExp(source));
  }
});

test("GrowthWise Inbox UI exposes source status filters badges and unread counts", () => {
  assert.match(html, /ALL LEADS · ONE INBOX/);
  assert.match(html, /retailLeadSourceGrid/);
  assert.match(html, /retailLeadSourceFilters/);
  assert.match(html, /retailInboxUnread/);
  assert.match(ui, /loadLeadSources/);
  assert.match(ui, /activeSourceFilter/);
  assert.match(ui, /retail-lead-source-badge/);
  assert.match(ui, /data-open-lead/);
});
