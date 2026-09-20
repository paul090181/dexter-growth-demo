import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../../show-growthwise.html", import.meta.url), "utf8");
const leads = await readFile(new URL("../../netlify/functions/growthwise-interest.mjs", import.meta.url), "utf8");
const feedback = await readFile(new URL("../../netlify/functions/pilot-feedback.mjs", import.meta.url), "utf8");

test("public GrowthWise showcase is industry-neutral and captures referrals", () => {
  assert.match(page, /GrowthWise for Small Business/);
  assert.match(page, /Request GrowthWise access/);
  assert.match(page, /referral_code/);
  assert.match(page, /growthwise-interest/);
  assert.match(page, /navigator\.share/);
  assert.doesNotMatch(page, /GROWTHWISE_ADMIN_KEY/);
});

test("interest endpoint allows public POST but protects lead listing", () => {
  assert.match(leads, /request\.method === "GET"/);
  assert.match(leads, /x-growthwise-key/);
  assert.match(leads, /\["GET","POST"\]\.includes\(request\.method\)/);
  assert.match(leads, /growthwise_interest_leads/);
  assert.match(leads, /website/);
});

test("pilot feedback remains authenticated and business-scoped", () => {
  assert.match(feedback, /GROWTHWISE_ADMIN_KEY/);
  assert.match(feedback, /business_id/);
  assert.match(feedback, /needs-improvement/);
  assert.match(feedback, /growthwise_pilot_feedback/);
});
