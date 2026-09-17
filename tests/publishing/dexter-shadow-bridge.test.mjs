import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");

test("Dexter Square success submits the four approved shadow channels", () => {
  const helper = html.slice(html.indexOf("async function sendDexterPublishingShadow"), html.indexOf("async function publishNewProductToFacebook"));
  for (const channel of ["facebook-page", "facebook-marketplace", "instagram", "website"]) {
    assert.match(helper, new RegExp(`['\"]${channel}['\"]`));
  }
  assert.match(helper, /business_id:\s*['"]dexters-hats['"]/);
  assert.match(helper, /vertical:\s*['"]retail['"]/);
  assert.match(helper, /role:\s*['"]owner_admin['"]/);
});

test("shadow bridge is best-effort and cannot enter legacy failure handling", () => {
  const helper = html.slice(html.indexOf("async function sendDexterPublishingShadow"), html.indexOf("async function publishNewProductToFacebook"));
  assert.match(helper, /catch\s*\([^)]*\)/);
  assert.match(helper, /console\.warn/);
  assert.match(html, /void sendDexterPublishingShadow\(form, created\)/);
  assert.doesNotMatch(helper, /throw\s/);
});
