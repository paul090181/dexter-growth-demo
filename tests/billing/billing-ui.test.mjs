import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../../index.html", import.meta.url), "utf8");

test("page sends only business_id and the existing access key", () => {
  assert.match(page, /fetch\('\/.netlify\/functions\/stripe-checkout'/);
  assert.match(page, /body:\s*JSON\.stringify\(\{\s*business_id:\s*['"]dexters-hats['"]\s*\}\)/);
  assert.match(page, /['"]X-GrowthWise-Key['"]:\s*key/);
  const forbiddenSecretPattern = new RegExp(["STRIPE_SECRET_KEY", "price_1UIE9x41OQl1gXUmJgdRK1nZ", "sk_(?:test|live)_", "wh" + "sec_"].join("|"));
  assert.doesNotMatch(page, forbiddenSecretPattern);
});

test("page validates Stripe-hosted HTTPS before redirecting", () => {
  assert.match(page, /checkoutUrl\.protocol\s*===\s*['"]https:['"]/);
  assert.match(page, /checkoutUrl\.hostname\s*===\s*['"]checkout\.stripe\.com['"]/);
  assert.match(page, /window\.location\.href\s*=\s*checkoutUrl\.href/);
});

test("page never treats a success query parameter as activation", () => {
  assert.match(page, /billingResult\s*===\s*['"]success['"]/);
  assert.match(page, /refreshSubscriptionStatus\(\)/);
  assert.doesNotMatch(page, /billingResult\s*===\s*['"]success['"][\s\S]{0,200}(?:active|activated|subscribed)/i);
});

test("Founding Plan checkout remains disabled until an access key is ready", () => {
  assert.match(page, /id="foundingCheckoutBtn"[^>]*disabled/);
  assert.match(page, /growthwise:admin-key-ready/);
  assert.match(page, /foundingCheckoutBtn\.disabled\s*=\s*!key/);
});
