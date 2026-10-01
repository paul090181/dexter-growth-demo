import { randomUUID } from "node:crypto";

import { getChannel } from "./registry.mjs";

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function supportedMedia(media, capabilities, warnings) {
  const approved = media.filter((item) => item?.approved !== false);
  const kept = approved.filter((item) => (
    (item.type === "image" && capabilities.photos !== false)
    || (item.type === "video" && capabilities.video !== false)
  ));
  const photoLimit = typeof capabilities.photos === "number" ? capabilities.photos : null;
  const videoLimit = typeof capabilities.video === "number" ? capabilities.video : null;
  let photos = 0;
  let videos = 0;
  const limited = kept.filter((item) => {
    if (item.type === "image") return photoLimit === null || photos++ < photoLimit;
    return videoLimit === null || videos++ < videoLimit;
  });

  if (limited.length !== media.length) {
    warnings.push(`Some media is unsupported or unavailable for this channel and was omitted.`);
  }
  return clone(limited);
}

export function createChannelDraft(masterPackage, channelId, options = {}) {
  const channel = getChannel(channelId);
  if (!channel) throw new RangeError(`Unknown channel: ${channelId}`);
  if (!masterPackage?.business_id) throw new TypeError("masterPackage.business_id is required");

  const now = new Date().toISOString();
  const warnings = [];
  const price = channel.capabilities.price === false
    ? null
    : clone(masterPackage.verified_facts?.price ?? null);
  if (channel.capabilities.price === false && masterPackage.verified_facts?.price != null) {
    warnings.push("Price is not supported by this channel and was omitted.");
  }
  const category = channel.capabilities.categories === false ? null : (options.category ?? null);
  if (channel.capabilities.categories === false && options.category != null) {
    warnings.push("Categories are not supported by this channel and were omitted.");
  }
  const callsToAction = channel.capabilities.links === false
    ? []
    : clone(options.calls_to_action ?? []);
  if (channel.capabilities.links === false && options.calls_to_action?.length) {
    warnings.push("Linked calls to action are not supported by this channel and were omitted.");
  }

  return {
    draft_id: randomUUID(),
    business_id: masterPackage.business_id,
    master_id: masterPackage.master_id ?? masterPackage.id ?? masterPackage.source?.id ?? null,
    channel_id: channelId,
    title: options.title ?? masterPackage.title,
    description: options.description ?? masterPackage.description,
    price,
    media: supportedMedia(masterPackage.media ?? [], channel.capabilities, warnings),
    category,
    calls_to_action: callsToAction,
    warnings,
    protected_fact_overrides: clone(options.protected_fact_overrides ?? []),
    created_at: now,
    updated_at: now,
  };
}
