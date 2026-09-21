import { INSTAGRAM_AUTHORIZATION_SCOPE, INSTAGRAM_IDENTITY_SCOPE } from "./_instagram-oauth.mjs";
import growthwiseDev from "../../clients/growthwise-dev.json" with { type: "json" };
import dextersHats from "../../clients/dexters-hats.json" with { type: "json" };

const CLIENT_CONFIGS = [
  ["growthwise-dev", growthwiseDev, "growthwise-dev-integration"],
  ["dexters-hats", dextersHats, "dexter-integration"],
];

export const INSTAGRAM_CLIENTS = Object.freeze(Object.fromEntries(CLIENT_CONFIGS.map(([businessId, config, returnDestinationId]) => {
  if (config.business_id !== businessId) throw new Error("Instagram client configuration mismatch.");
  const reviewPublishEnabled = config.integrations?.instagram?.review_publish_enabled === true;
  const messagesEnabled = config.integrations?.instagram?.messages_enabled === true;
  return [businessId, Object.freeze({
    business_id: businessId,
    returnDestinationId,
    authorizationScope: reviewPublishEnabled || messagesEnabled ? INSTAGRAM_AUTHORIZATION_SCOPE : INSTAGRAM_IDENTITY_SCOPE,
    messagesEnabled,
  })];
})));

export const INSTAGRAM_RETURN_DESTINATIONS = Object.freeze({
  "growthwise-dev-integration": "/instagram-dev.html",
  "dexter-integration": "/",
});

const SAFE_HINTS = new Set(["connected", "cancelled", "attention"]);

export function getInstagramClient(businessId) {
  if (typeof businessId !== "string" || !Object.hasOwn(INSTAGRAM_CLIENTS, businessId)) {
    throw new Error("Instagram client is not configured.");
  }
  return INSTAGRAM_CLIENTS[businessId];
}

function canonicalOrigin(publicOrigin) {
  let url;
  try { url = new URL(publicOrigin); } catch { throw new Error("Invalid public origin."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid public origin.");
  }
  return url.origin;
}

export function resolveInstagramReturnDestination({ destinationId, hint, publicOrigin }) {
  if (!Object.hasOwn(INSTAGRAM_RETURN_DESTINATIONS, destinationId)) throw new Error("Unknown return destination.");
  if (!SAFE_HINTS.has(hint)) throw new Error("Unsafe return hint.");
  const result = new URL(INSTAGRAM_RETURN_DESTINATIONS[destinationId], canonicalOrigin(publicOrigin));
  result.searchParams.set("instagram", hint);
  return result.toString();
}
