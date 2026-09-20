import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");

test("Dexter inline application scripts remain syntactically valid", () => {
  const scripts = [...html.matchAll(/<script(?![^>]*type=["']module["'])[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(match[1], { filename: `index-inline-${index}.js` }));
  }
});

test("camera-first intake and unified publishing controls are present", () => {
  assert.match(html, /SCAN → REVIEW → PUBLISH/);
  assert.match(html, /id="productIntakeCameraInput"/);
  assert.match(html, /id="productIntakeGalleryInput"/);
  assert.match(html, /id="newProductFacebookChannel"/);
  assert.match(html, /id="newProductInstagramChannel"/);
  assert.match(html, />Create &amp; Publish</);
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
