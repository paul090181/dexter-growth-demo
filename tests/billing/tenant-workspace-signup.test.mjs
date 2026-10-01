import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../signup.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../../assets/tenant-signup.js", import.meta.url), "utf8");
const source = `${html}\n${js}`;

test("signup hands off both workspace credentials to the customer", () => {
  assert.match(html, /id="oneTimeBusinessId"/);
  assert.match(html, /signed in on this device/i);
  assert.match(html, /another device/i);
  assert.match(source, /oneTimeBusinessId\.textContent = data\.business_id/);
  assert.match(html, /href="\.\/app\.html\?onboarding=1"/);
});
