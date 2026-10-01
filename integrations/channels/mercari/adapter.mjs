import { prepareExport } from "../_contract.mjs";

export const channelId = "mercari";

export function prepare(input) {
  return prepareExport(channelId, input, [
    "Review the normalized export payload before using it outside GrowthWise.",
    "No network request or live publishing action was performed.",
  ]);
}
