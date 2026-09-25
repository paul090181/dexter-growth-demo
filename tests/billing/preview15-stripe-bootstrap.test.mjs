import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../netlify/functions/preview15-stripe-bootstrap.mjs", import.meta.url),
  "utf8",
);

test("Preview 15 Stripe bootstrap is constrained to the known test sandbox", () => {
  assert.match(source, /startsWith\("deploy-preview-15--"\)/);
  assert.match(source, /acct_1UICQv41OQl1gXUm/);
  assert.match(source, /livemode !== false/);
  assert.match(source, /unit_amount !== 4900/);
  assert.match(source, /we_1UIRDb41OQl1gXUmVhrwXrQk/);
  assert.doesNotMatch(source, /webhook.*secret/i);
});

test("Preview 15 Stripe bootstrap creates only the three standard paid test plans", () => {
  assert.match(source, /starter_monthly/);
  assert.match(source, /growth_monthly/);
  assert.match(source, /pro_monthly/);
  assert.match(source, /9900/);
  assert.match(source, /19900/);
  assert.match(source, /39900/);
  assert.match(source, /preview15_acceptance/);
});
