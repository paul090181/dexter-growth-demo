import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../signup.html", import.meta.url), "utf8");

test("paid tenant UI exposes secure Stripe billing management", () => {
  assert.match(html, /id="manageBillingButton"/);
  assert.match(html, /\.netlify\/functions\/stripe-customer-portal/);
  assert.match(html, /portalUrl\.hostname === 'billing\.stripe\.com'/);
  assert.match(html, /billingResult === 'manage-return'/);
});

test("billing management visibility comes from server subscription source", () => {
  assert.match(html, /const stripeLinked = data\.access_source === 'stripe'/);
  assert.match(html, /manageBillingButton\.classList\.toggle\('hidden', !stripeLinked\)/);
});
