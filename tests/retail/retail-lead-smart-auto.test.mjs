import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const backend = await readFile(new URL("../../netlify/functions/retail-lead-assistant.mjs", import.meta.url), "utf8");
const settings = await readFile(new URL("../../netlify/functions/retail-lead-settings.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../../assets/retail-leads.mjs", import.meta.url), "utf8");
const migration = await readFile(new URL("../../netlify/database/migrations/20260920201500_retail-lead-smart-auto/migration.sql", import.meta.url), "utf8");

test("Smart Auto pilot stores shadow-mode decisions without live delivery", () => {
  assert.match(migration, /retail_lead_automation_settings/);
  assert.match(migration, /would_auto_send/);
  assert.match(backend, /automation_class/);
  assert.match(backend, /would_auto_reply/);
  assert.match(backend, /would_auto_ack_then_review/);
  assert.match(backend, /human_review_only/);
  assert.match(backend, /Live delivery is intentionally disabled/);
});

test("Lead settings allow Draft Only and Shadow Mode but reject live Smart Auto", () => {
  assert.match(settings, /draft_only/);
  assert.match(settings, /shadow/);
  assert.match(settings, /Live Smart Auto is not available until a supported customer-messaging channel is connected and approved/);
  assert.match(settings, /auto_reply_intents/);
  assert.match(settings, /auto_ack_intents/);
});

test("Retail Lead UI exposes shadow decisions and pilot counts", () => {
  assert.match(ui, /loadAutomationSettings/);
  assert.match(ui, /saveAutomationMode/);
  assert.match(ui, /WOULD AUTO-REPLY/);
  assert.match(ui, /WOULD ACKNOWLEDGE, THEN ALERT DEXTER/);
  assert.match(ui, /WOULD WAIT FOR DEXTER/);
  assert.match(ui, /retailLeadSafeCount/);
  assert.match(ui, /retailLeadAckCount/);
  assert.match(ui, /retailLeadHumanCount/);
});

test("Lead UI unlocks in place and refreshes verified Square data", () => {
  assert.match(ui, /unlockLeads/);
  assert.match(ui, /retailLeadUnlockKey/);
  assert.match(ui, /square-data/);
  assert.match(ui, /growthwise:admin-key-ready/);
  assert.match(ui, /growthwise:inventory-updated/);
  assert.match(ui, /unified inbox are ready/);
});
