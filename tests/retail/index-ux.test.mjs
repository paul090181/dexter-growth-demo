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

test("Dexter workflow headings float like the automotive pilot", () => {
  assert.match(html, /workflow-quick-nav-shell/);
  assert.match(html, /position:fixed/);
  assert.match(html, /Add Products/);
  assert.match(html, />Instagram</);
  assert.match(html, />Inventory</);
  assert.match(html, />Orders</);
  assert.match(html, />Money</);
  assert.match(html, />Ask AI</);
  assert.match(html, /workflow-nav-btn/);
});

test("Orders refreshes and searches the same Square inventory used elsewhere", () => {
  assert.match(retailOps, /window\.loadLiveSquareData/);
  assert.match(retailOps, /p\.description/);
  assert.match(retailOps, /growthwise:inventory-updated/);
  assert.match(html, /RECENT_SQUARE_PRODUCTS_KEY/);
  assert.match(html, /mergeRecentSquareProducts/);
});

test("purchase orders can be saved or shared as PDF", () => {
  assert.match(retailOps, /Save PDF/);
  assert.match(retailOps, /Send \/ Share/);
  assert.match(retailOps, /retail-order-pdf/);
  assert.match(retailOps, /navigator\.share/);
  assert.match(retailOps, /application\/pdf/);
});

test("Dexter pilot leads with Instagram-only quick posting", () => {
  assert.match(html, /Instagram Post/);
  assert.match(html, /data-instagram-quick/);
  assert.match(html, /INSTAGRAM FIRST/);
  assert.match(html, /No Square changes\. No Facebook posting\./);
  assert.match(html, /instagram-photo-draft/);
  assert.match(html, /Post to Instagram/);
  assert.match(html, /instagramQuickUnlock/);
});

test("Dexter pilot stays broad while Instagram is the first test", () => {
  assert.match(html, /DEXTER PILOT/);
  assert.match(html, /Try GrowthWise one piece at a time/);
  assert.match(html, /Instagram is a good first test, but the goal is to find out what works across the whole app/);
  assert.match(html, /Add a Product/);
  assert.match(html, /Promote Existing Product/);
  assert.match(html, /Orders &amp; Restocking/);
  assert.match(html, /Ask GrowthWise/);
});

test("Dexter can capture pilot feedback and share GrowthWise referrals", () => {
  assert.match(html, /pilot-feedback/);
  assert.match(html, /Worked/);
  assert.match(html, /Needs improvement/);
  assert.match(html, /Show GrowthWise/);
  assert.match(html, /show-growthwise\.html\?ref=dexter-broadway/);
  assert.match(html, /navigator\.share/);
});

test("Dexter pilot exposes a persistent Retail Lead Assistant", () => {
  assert.match(html, /data-nav="leads"/);
  assert.match(html, /<h2>Lead Assistant<\/h2>/);
  assert.match(html, /Instagram DMs, Facebook messages, texts, website questions/);
  assert.match(html, /Draft Customer Reply/);
  assert.match(html, /RECENT CUSTOMER QUESTIONS/);
  assert.match(html, /assets\/retail-leads\.mjs/);
});

test("Lead Assistant includes Smart Auto shadow-mode pilot controls", () => {
  assert.match(html, /SMART AUTO PILOT/);
  assert.match(html, /Learn first\. Automate second\./);
  assert.match(html, /Shadow Mode/);
  assert.match(html, /Live Smart Auto/);
  assert.match(html, /No customer messages are being sent automatically/);
  assert.match(html, /SAFE AUTO/);
  assert.match(html, /AUTO ACK \+ DEXTER/);
  assert.match(html, /HUMAN ONLY/);
});

test("Lead Assistant can unlock inline without leaving the workflow", () => {
  assert.match(html, /id="retailLeadUnlock"/);
  assert.match(html, /Stay right here in Leads/);
  assert.match(html, /id="retailLeadUnlockKey"/);
  assert.match(html, /id="retailLeadUnlockBtn"/);
});
