import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("../../netlify/functions/preview15-stripe-inspect.mjs", import.meta.url),
  "utf8",
);

test("Stripe inspector is hard-limited to Preview 15 and never returns secrets", () => {
  assert.match(source, /startsWith\("deploy-preview-15--"\)/);
  assert.match(source, /endsWith\("\\.netlify\\.app"\)/);
  assert.match(source, /return json\(404/);
  assert.doesNotMatch(source, /webhook.*secret|secretKey[,}]/i);
  assert.match(source, /livemode/);
});
