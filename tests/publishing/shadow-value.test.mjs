import test from "node:test";
import assert from "node:assert/strict";
import { summarizeShadowValue } from "../../core/publishing/metrics/shadow-value.mjs";

test("shadow value metrics count factual outcomes without revenue claims", () => {
  const value = summarizeShadowValue({
    results: [
      { channel_id: "instagram", status: "Draft", live_sent: false },
      { channel_id: "website", status: "Failed", live_sent: false },
      { channel_id: "facebook-page", status: "Waiting Approval", live_sent: false },
    ],
  }, { preparationDurationMs: 42 });
  assert.deepEqual(value, {
    products_processed: 1,
    channel_drafts_prepared: 2,
    channels_attempted: 3,
    successful_preparations: 2,
    failed_preparations: 1,
    manual_actions_avoided_estimate: 2,
    preparation_duration_ms: 42,
  });
  assert.equal(JSON.stringify(value).includes("revenue"), false);
});

test("shadow value metrics reject invalid durations and malformed results", () => {
  assert.throws(() => summarizeShadowValue({}, { preparationDurationMs: 1 }), /results/);
  assert.throws(() => summarizeShadowValue({ results: [] }, { preparationDurationMs: -1 }), /duration/);
});
