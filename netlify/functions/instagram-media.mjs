import { readInstagramImage } from "./_instagram-media-store.mjs";

function safeAssetId(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/.netlify/functions/instagram-media" || url.hash) return null;
  const entries = [...url.searchParams];
  if (entries.length !== 1 || entries[0][0] !== "asset_id") return null;
  return entries[0][1];
}

export function createInstagramMediaHandler({ readImage = readInstagramImage, now = () => new Date() } = {}) {
  return async function instagramMedia(request) {
    if (request.method !== "GET") {
      return new Response("Method not allowed.", { status: 405, headers: { allow: "GET" } });
    }
    const assetId = safeAssetId(request);
    if (!assetId) return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });

    let image;
    try {
      image = await readImage(assetId, { now: now() });
    } catch {
      return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
    }
    if (!image) return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });

    return new Response(image.data, {
      status: 200,
      headers: {
        "content-type": image.contentType,
        "cache-control": "public, max-age=300",
        "x-content-type-options": "nosniff",
      },
    });
  };
}

export default createInstagramMediaHandler();
