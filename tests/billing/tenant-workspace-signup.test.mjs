import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../signup.html", import.meta.url), "utf8");

test("signup hands off both workspace credentials to the customer", () => {
  assert.match(html, /id="oneTimeBusinessId"/);
  assert.match(html, /current browser session/i);
  assert.match(html, /another browser or device/i);
  assert.match(html, /oneTimeBusinessId\.textContent = data\.business_id/);
  assert.match(html, /href="\.\/app\.html\?onboarding=1"/);
});
