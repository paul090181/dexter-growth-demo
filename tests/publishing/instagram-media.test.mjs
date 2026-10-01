import test from "node:test";
import assert from "node:assert/strict";

import {
  stageInstagramImage,
  readInstagramImage,
} from "../../netlify/functions/_instagram-media-store.mjs";
import { createInstagramMediaHandler } from "../../netlify/functions/instagram-media.mjs";

function memoryStore() {
  const values = new Map();
  return {
    values,
    async set(key, value) { values.set(key, value); },
    async setJSON(key, value) { values.set(key, structuredClone(value)); },
    async get(key, options = {}) {
      const value = values.get(key) ?? null;
      if (value === null) return null;
      if (options.type === "json") return structuredClone(value);
      if (options.type === "arrayBuffer" && value instanceof Blob) return value.arrayBuffer();
      return value;
    },
  };
}

const JPEG = "data:image/jpeg;base64,/9j/2Q==";

test("staging creates an opaque 24-hour HTTPS asset without embedding tenant or image bytes in the URL", async () => {
  const store = memoryStore();
  const now = new Date("2026-09-20T12:00:00.000Z");
  const staged = await stageInstagramImage({
    businessId: "dexters-hats",
    imageDataUrl: JPEG,
    publicOrigin: "https://growthwise.example",
    now,
    store,
    randomBytesImpl: () => Buffer.alloc(24, 7),
  });

  assert.equal(staged.assetId, Buffer.alloc(24, 7).toString("base64url"));
  assert.equal(staged.expiresAt.toISOString(), "2026-09-21T12:00:00.000Z");
  const url = new URL(staged.publicUrl);
  assert.equal(url.origin, "https://growthwise.example");
  assert.equal(url.pathname, "/.netlify/functions/instagram-media");
  assert.equal(url.searchParams.get("asset_id"), staged.assetId);
  assert.equal(staged.publicUrl.includes("dexters-hats"), false);
  assert.equal(staged.publicUrl.includes("/9j/"), false);
});

test("staged Instagram media reads only before expiry", async () => {
  const store = memoryStore();
  const staged = await stageInstagramImage({
    businessId: "dexters-hats",
    imageDataUrl: JPEG,
    publicOrigin: "https://growthwise.example",
    now: new Date("2026-09-20T12:00:00.000Z"),
    store,
    randomBytesImpl: () => Buffer.alloc(24, 8),
  });

  const active = await readInstagramImage(staged.assetId, {
    now: new Date("2026-09-20T12:05:00.000Z"),
    store,
  });
  assert.equal(active.contentType, "image/jpeg");
  assert.equal(Buffer.from(active.data).length > 0, true);

  const expired = await readInstagramImage(staged.assetId, {
    now: new Date("2026-09-21T12:00:00.001Z"),
    store,
  });
  assert.equal(expired, null);
});

test("staging accepts JPEG only and enforces valid public origin", async () => {
  const store = memoryStore();
  await assert.rejects(stageInstagramImage({
    businessId: "dexters-hats",
    imageDataUrl: "data:image/png;base64,iVBORw0KGgo=",
    publicOrigin: "https://growthwise.example",
    store,
  }), /JPEG/i);
  await assert.rejects(stageInstagramImage({
    businessId: "dexters-hats",
    imageDataUrl: JPEG,
    publicOrigin: "http://growthwise.example",
    store,
  }), /public origin/i);
});

test("public media handler serves a staged JPEG without exposing metadata", async () => {
  const bytes = Uint8Array.from([255, 216, 255, 217]).buffer;
  const handler = createInstagramMediaHandler({
    now: () => new Date("2026-09-20T12:00:00.000Z"),
    readImage: async (assetId) => assetId === "A".repeat(32)
      ? { data: bytes, contentType: "image/jpeg", businessId: "dexters-hats", expiresAt: new Date("2026-09-21T12:00:00Z") }
      : null,
  });
  const response = await handler(new Request(`https://growthwise.example/.netlify/functions/instagram-media?asset_id=${"A".repeat(32)}`));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [255, 216, 255, 217]);
  assert.equal(response.headers.has("x-growthwise-business"), false);
});

test("public media handler fails closed for unknown malformed or expired assets", async () => {
  let reads = 0;
  const handler = createInstagramMediaHandler({
    readImage: async () => { reads += 1; return null; },
  });
  assert.equal((await handler(new Request("https://growthwise.example/.netlify/functions/instagram-media?asset_id=bad"))).status, 404);
  assert.equal((await handler(new Request("https://growthwise.example/.netlify/functions/instagram-media?asset_id=bad&extra=1"))).status, 404);
  assert.equal((await handler(new Request("https://growthwise.example/.netlify/functions/instagram-media?asset_id=missing"))).status, 404);
  assert.equal(reads >= 1, true);
});
