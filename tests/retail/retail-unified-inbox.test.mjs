import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../../netlify/database/migrations/20260920215000_unified-lead-inbox/migration.sql", import.meta.url), "utf8");
const ingest = await readFile(new URL("../../netlify/functions/retail-lead-ingest.mjs", import.meta.url), "utf8");
const sources = await readFile(new URL("../../netlify/functions/retail-lead-sources.mjs", import.meta.url), "utf8");
const assistant = await readFile(new URL("../../netlify/functions/retail-lead-assistant.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../../assets/retail-leads.mjs", import.meta.url), "utf8");
const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");

test("unified retail inbox stores normalized source and external ids", () => {
  assert.match(migration, /source_type TEXT NOT NULL DEFAULT 'manual'/);
  assert.match(migration, /external_thread_id/);
  assert.match(migration, /external_message_id/);
  assert.match(migration, /reply_supported/);
  assert.match(migration, /source_metadata JSONB/);
  assert.match(migration, /retail_customer_leads_external_message_idx/);
});

test("normalized ingestion is idempotent and connector-ready", () => {
  assert.match(ingest, /GROWTHWISE_RETAIL_LEAD_INGEST_KEY/);
  assert.match(ingest, /external_message_id/);
  assert.match(ingest, /duplicate: true/);
  assert.match(ingest, /growthwise_lead_sources/);
  assert.match(ingest, /inbound_enabled/);
  assert.match(ingest, /outbound_enabled/);
});

test("lead source status catalog covers common SMB channels", () => {
  for (const source of ["instagram","facebook","email","website","sms","phone","manual","other"]) {
    assert.match(sources, new RegExp(`"${source}"`));
  }
});

test("manual Lead Assistant entries normalize into the same inbox", () => {
  assert.match(assistant, /sourceTypeFromLabel/);
  assert.match(assistant, /source_type/);
  assert.match(assistant, /received_at/);
  assert.match(assistant, /unread/);
});

test("GrowthWise Inbox filters and opens messages into Lead Assistant", () => {
  assert.match(html, /GrowthWise Inbox/);
  assert.match(html, /ALL LEADS · ONE INBOX/);
  assert.match(html, /Instagram, Facebook, email, website forms, text\/SMS/);
  assert.match(ui, /activeSourceFilter/);
  assert.match(ui, /loadLeadSources/);
  assert.match(ui, /renderInboxSummary/);
  assert.match(ui, /openLead/);
  assert.match(ui, /data-open-lead/);
  assert.match(ui, /unread:false/);
});
