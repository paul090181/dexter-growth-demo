/**
 * Produce conservative preparation metrics. Each successful channel draft counts
 * as one avoided manual draft-preparation action; this is not revenue attribution.
 */
export function summarizeShadowValue(run, { preparationDurationMs } = {}) {
  if (!Array.isArray(run?.results)) throw new TypeError("run.results must be an array");
  if (!Number.isFinite(preparationDurationMs) || preparationDurationMs < 0) {
    throw new TypeError("preparation duration must be a non-negative number");
  }
  const failed = run.results.filter(({ status }) => status === "Failed").length;
  const successful = run.results.length - failed;
  return {
    products_processed: run.results.length ? 1 : 0,
    channel_drafts_prepared: successful,
    channels_attempted: run.results.length,
    successful_preparations: successful,
    failed_preparations: failed,
    manual_actions_avoided_estimate: successful,
    preparation_duration_ms: Math.round(preparationDurationMs),
  };
}
