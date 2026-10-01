import { randomBytes } from "node:crypto";
import { getDeployStore, getStore } from "@netlify/blobs";

const STORE_NAME = "growthwise-instagram-media-v1";
const ASSET_ID_BYTES = 24;
const ASSET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ASSET_ID = /^[A-Za-z0-9_-]{32}$/;

function configuredContext() {
  return globalThis.Netlify?.env?.get("CONTEXT") ?? "";
}

export function instagramMediaStore({ context = configuredContext() } = {}) {
  return context === "production"
    ? getStore({ name: STORE_NAME, consistency: "strong" })
    : getDeployStore({ name: STORE_NAME });
}

function parseJpegDataUrl(value) {
  if (typeof value !== "string") throw new TypeError("A JPEG image is required.");
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!match) throw new TypeError("Instagram publishing requires a JPEG image.");
  const bytes = Buffer.from(match[1], "base64");
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) throw new RangeError("Instagram image must be 5 MB or smaller.");
  if (bytes.toString("base64").replace(/=+$/u, "") !== match[1].replace(/=+$/u, "")) {
    throw new TypeError("Instagram image data is invalid.");
  }
  return bytes;
}

export async function stageInstagramImage({
  businessId,
  imageDataUrl,
  publicOrigin,
  now = new Date(),
  store = instagramMediaStore(),
  randomBytesImpl = randomBytes,
} = {}) {
  if (typeof businessId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId)) {
    throw new TypeError("A valid business ID is required.");
  }
  const origin = new URL(publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== publicOrigin || origin.pathname !== "/" || origin.search || origin.hash) {
    throw new TypeError("A valid public origin is required.");
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("A valid current time is required.");

  const bytes = parseJpegDataUrl(imageDataUrl);
  const idBytes = Buffer.from(randomBytesImpl(ASSET_ID_BYTES));
  if (idBytes.length !== ASSET_ID_BYTES) throw new Error("INVALID_RANDOM_SOURCE");
  const assetId = idBytes.toString("base64url");
  const expiresAt = new Date(now.getTime() + ASSET_TTL_MS);
  const assetKey = `asset/${assetId}.jpg`;
  const metaKey = `meta/${assetId}`;

  await store.set(assetKey, new Blob([bytes], { type: "image/jpeg" }));
  await store.setJSON(metaKey, {
    business_id: businessId,
    content_type: "image/jpeg",
    expires_at: expiresAt.toISOString(),
  });

  const url = new URL("/.netlify/functions/instagram-media", origin);
  url.searchParams.set("asset_id", assetId);
  return { assetId, publicUrl: url.toString(), expiresAt };
}

export async function readInstagramImage(assetId, {
  now = new Date(),
  store = instagramMediaStore(),
} = {}) {
  if (typeof assetId !== "string" || !ASSET_ID.test(assetId)) return null;
  const meta = await store.get(`meta/${assetId}`, { type: "json" });
  if (!meta || meta.content_type !== "image/jpeg" || typeof meta.expires_at !== "string") return null;
  const expiresAt = new Date(meta.expires_at);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return null;
  const data = await store.get(`asset/${assetId}.jpg`, { type: "arrayBuffer" });
  if (!data) return null;
  return { data, contentType: "image/jpeg", expiresAt, businessId: meta.business_id };
}
