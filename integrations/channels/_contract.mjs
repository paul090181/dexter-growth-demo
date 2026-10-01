import { getChannel } from "../../core/publishing/channels/registry.mjs";

export function prepareExport(channelId, { masterPackage, draft }, instructions = []) {
  const channel = getChannel(channelId);
  if (!channel) throw new RangeError(`Unknown channel: ${channelId}`);
  if (draft?.channel_id !== channelId) throw new TypeError(`Draft is not for ${channelId}`);
  if (!masterPackage?.business_id || draft.business_id !== masterPackage.business_id) {
    throw new TypeError("Draft and master package business_id must match");
  }

  return {
    channel_id: channelId,
    delivery_mode: channel.deliveryMode,
    implementation_status: channel.implementationStatus,
    payload: {
      business_id: draft.business_id,
      master_id: draft.master_id,
      draft_id: draft.draft_id,
      title: draft.title,
      description: draft.description,
      price: draft.price,
      media: structuredClone(draft.media),
      category: draft.category,
      calls_to_action: structuredClone(draft.calls_to_action),
      shadow_only: true,
    },
    instructions: [...instructions],
  };
}
