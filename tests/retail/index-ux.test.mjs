import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const retailOps = await readFile(new URL("../../assets/retail-ops.mjs", import.meta.url), "utf8");

test("Dexter inline application scripts remain syntactically valid", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*type=["']module["'])[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(match[1], { filename: `index-inline-${index}.js` }));
  }
});

test("camera-first intake and unified publishing controls are present", () => {
  assert.match(html, /<h2>Add New Products<\/h2>/);
  assert.match(html, /id="productIntakeCameraInput"/);
  assert.match(html, /id="productIntakeGalleryInput"/);
  assert.match(html, /id="newProductFacebookChannel"/);
  assert.match(html, /id="newProductInstagramChannel"/);
  assert.match(html, />Add \+ Promote Now</);
});

test("integration plumbing lives under Connected Apps instead of the home opportunity stack", () => {
  assert.match(html, /id="settings"/);
  assert.match(html, />Connected Apps</);
  assert.equal((html.match(/id="instagram-connection"/g) || []).length, 1);
});

test("home includes proactive AI suggestion surface", () => {
  assert.match(html, /id="aiOpportunityPanel"/);
  assert.match(html, /id="aiOpportunityStack"/);
  assert.match(html, /retail-opportunities/);
});

test("home uses task-first plain-English navigation", () => {
  for (const label of [
    "Add New Products",
    "Promote Products",
    "View Inventory",
    "Ask GrowthWise",
  ]) {
    assert.match(html, new RegExp(label));
  }
  assert.match(html, /class="task-launcher"/);
});

test("product photos persist locally for retry and reuse", () => {
  assert.match(html, /indexedDB\.open\(PRODUCT_PHOTO_DB/);
  assert.match(html, /PRODUCT_PHOTO_LIMIT = 30/);
  assert.match(html, /Recent Product Photos/);
  assert.match(html, /data-recent-photo-id/);
  assert.match(html, /saveProductPhotoToDevice/);
});

test("new product flow offers inventory-only or add-and-promote choices", () => {
  assert.match(html, /id="addInventoryOnlyChoice"/);
  assert.match(html, /id="addAndPromoteChoice"/);
  assert.match(html, />Add to Inventory</);
  assert.match(html, />Add \+ Promote Now</);
});

test("promote products can choose an existing Square product", () => {
  assert.match(html, /id="promotionProductSearch"/);
  assert.match(html, /CHOOSE AN EXISTING PRODUCT/);
  assert.match(html, /retail-product-promotion/);
  assert.match(html, /Product Spotlight/);
});

test("GrowthWise one-stop retail shell exposes Orders and Money", () => {
  assert.match(html, /Orders &amp; Restocking/);
  assert.match(html, /<h2>Money<\/h2>/);
  assert.match(html, /id="purchaseOrderComposer"/);
  assert.match(retailOps, /retail-order-receive/);
  assert.match(retailOps, /Receive into Square/);
  assert.match(html, /assets\/retail-ops\.mjs/);
  assert.match(html, /GROWTHWISE RESTOCK ASSISTANT/);
});
