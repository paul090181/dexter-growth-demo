import { DELIVERY_MODES } from "../constants.mjs";

const DEFAULT_CAPABILITIES = Object.freeze({
  photos: false,
  video: false,
  price: false,
  inventory: false,
  location: false,
  categories: false,
  links: false,
  update: false,
  remove: false,
  statusReadback: false,
});

function channel(id, displayName, deliveryMode, implementationStatus) {
  if (!DELIVERY_MODES.includes(deliveryMode)) {
    throw new TypeError(`Unsupported delivery mode: ${deliveryMode}`);
  }

  return Object.freeze({
    id,
    displayName,
    deliveryMode,
    implementationStatus,
    capabilities: DEFAULT_CAPABILITIES,
    automaticActionsAllowed: false,
  });
}

export const CHANNELS = Object.freeze([
  channel("facebook-page", "Facebook Page", "direct", "existing-live-path-not-wired-to-core"),
  channel("facebook-marketplace", "Facebook Marketplace", "assisted", "shadow"),
  channel("instagram", "Instagram", "export", "registry-only"),
  channel("website", "Website", "export", "registry-only"),
  channel("ebay", "eBay", "export", "registry-only"),
  channel("etsy", "Etsy", "export", "registry-only"),
  channel("pinterest", "Pinterest", "export", "registry-only"),
  channel("craigslist", "Craigslist", "export", "registry-only"),
  channel("mercari", "Mercari", "export", "registry-only"),
  channel("tiktok", "TikTok", "export", "registry-only"),
  channel("google-business-profile", "Google Business Profile", "export", "registry-only"),
]);

const CHANNELS_BY_ID = new Map(CHANNELS.map((entry) => [entry.id, entry]));

export function getChannel(channelId) {
  return CHANNELS_BY_ID.get(channelId);
}

export function listChannels() {
  return [...CHANNELS];
}
