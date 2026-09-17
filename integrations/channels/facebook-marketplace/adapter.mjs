import { prepareExport } from "../_contract.mjs";

export const channelId = "facebook-marketplace";

export function prepare(input) {
  const prepared = prepareExport(channelId, input, [
    "Assisted mode: review the listing, then enter it manually in Facebook Marketplace.",
    "No Meta or Facebook network request was performed.",
  ]);
  return {
    ...prepared,
    payload: {
      business_id: prepared.payload.business_id,
      master_id: prepared.payload.master_id,
      draft_id: prepared.payload.draft_id,
      listing: {
        title: prepared.payload.title,
        description: prepared.payload.description,
        price: prepared.payload.price,
        media: prepared.payload.media,
        category: prepared.payload.category,
      },
      shadow_only: true,
    },
  };
}
