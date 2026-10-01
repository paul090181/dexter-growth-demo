import { prepareExport } from "../_contract.mjs";

export const channelId = "instagram";

export function prepare(input) {
  const prepared = prepareExport(channelId, input, [
    "Review the Instagram preview and connection health before authorization.",
    "Local/base64 media is preview-only; live publishing requires durable HTTPS media hosting.",
    "No network request or live publishing action was performed.",
  ]);
  const media = prepared.payload.media.map((item) => ({
    ...item,
    readiness: /^https:\/\//i.test(item.url || "") ? "remotely_retrievable" : "preview_only",
  }));
  const blockers = [];
  if (!media.length) blockers.push("At least one approved image is required.");
  if (media.some((item) => item.readiness !== "remotely_retrievable")) {
    blockers.push("Durable HTTPS media hosting is required before Instagram publishing.");
  }
  return {
    ...prepared,
    live_sent: false,
    preview: { caption: prepared.payload.description, media },
    publish_readiness: { ready: blockers.length === 0, blockers },
  };
}
