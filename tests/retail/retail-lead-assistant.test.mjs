import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const backend = await readFile(new URL("../../netlify/functions/retail-lead-assistant.mjs", import.meta.url), "utf8");
const ui = await readFile(new URL("../../assets/retail-leads.mjs", import.meta.url), "utf8");
const migration = await readFile(new URL("../../netlify/database/migrations/20260920194500_retail-customer-leads/migration.sql", import.meta.url), "utf8");

test("retail lead assistant persists customer leads by business", () => {
  assert.match(migration, /CREATE TABLE retail_customer_leads/);
  assert.match(backend, /business_id/);
  assert.match(backend, /INSERT INTO retail_customer_leads/);
  assert.match(backend, /UPDATE retail_customer_leads/);
});

test("retail lead assistant has server-side human-review guardrails", () => {
  assert.match(backend, /discount/);
  assert.match(backend, /hold/);
  assert.match(backend, /return_refund/);
  assert.match(backend, /custom_order/);
  assert.match(backend, /complaint/);
  assert.match(backend, /Nothing will be auto-sent during this pilot/);
  assert.match(backend, /auto_reply_then_review/);
  assert.match(backend, /review_required/);
});

test("retail lead UI can ground replies in Square inventory and share them", () => {
  assert.match(ui, /growthwiseInventoryProducts/);
  assert.match(ui, /retail-lead-assistant/);
  assert.match(ui, /navigator\.clipboard/);
  assert.match(ui, /navigator\.share/);
  assert.match(ui, /Mark Replied/);
});

test("retail lead assistant preserves verified facts while escalating risky requests", () => {
  assert.match(backend, /productFactLead/);
  assert.match(backend, /currently showing in stock/);
  assert.match(backend, /current listed price/);
  assert.match(backend, /Dexter still needs to confirm whether it can be held/);
  assert.match(backend, /answer verified product facts immediately/);
});

test("retail lead assistant asks for product clarification before using mismatched facts", () => {
  assert.match(backend, /product_match/);
  assert.match(backend, /product_clarification/);
  assert.match(backend, /which product are you asking about\?/);
  assert.match(backend, /send the name or style, or a photo/);
  assert.match(backend, /productSpecificWithoutMatch/);
  assert.match(backend, /const linkedProduct = productMatch === "matched" \? product : null/);
  assert.match(backend, /will not use that product's price or inventory/);
});
