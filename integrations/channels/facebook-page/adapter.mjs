import { prepareExport } from "../_contract.mjs";

export const channelId = "facebook-page";

export function prepare(input) {
  const prepared = prepareExport(channelId, input, [
    "Shadow comparison only; this adapter does not invoke the existing Facebook Page publisher.",
    "Review the message and image data before any separately authorized live action.",
  ]);
  return {
    ...prepared,
    payload: {
      business_id: prepared.payload.business_id,
      master_id: prepared.payload.master_id,
      draft_id: prepared.payload.draft_id,
      message: prepared.payload.description,
      image_data_urls: prepared.payload.media
        .filter(({ type }) => type === "image")
        .map(({ url }) => url),
      shadow_only: true,
    },
  };
}
