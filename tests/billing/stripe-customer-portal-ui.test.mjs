import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const html = fs.readFileSync(new URL("../../signup.html", import.meta.url), "utf8");
const js = fs.readFileSync(new URL("../../assets/tenant-signup.js", import.meta.url), "utf8");
const source = `${html}\n${js}`;

test("paid tenant UI exposes secure Stripe billing management", () => {
  assert.match(html, /id="manageBillingButton"/);
  assert.match(source, /\.netlify\/functions\/stripe-customer-portal/);
  assert.match(source, /portalUrl\.hostname === 'billing\.stripe\.com'/);
  assert.match(source, /billingResult === 'manage-return'/);
});

test("billing management visibility comes from server subscription source", () => {
  assert.match(source, /const stripeLinked = data\.access_source === 'stripe'/);
  assert.match(source, /manageBillingButton\.classList\.toggle\('hidden', !stripeLinked\)/);
});
