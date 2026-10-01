import test from "node:test";
import assert from "node:assert/strict";

import { listChannels } from "../../core/publishing/channels/registry.mjs";
import { createChannelDraft } from "../../core/publishing/channels/draft.mjs";
import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { automotiveToMasterInput } from "../../verticals/automotive/publishing-adapter/index.mjs";
import { retailToMasterInput } from "../../verticals/retail/publishing-adapter/index.mjs";
import { automotiveMedia, automotiveVehicle } from "./fixtures/automotive-vehicle.mjs";
import { retailMedia, retailProduct } from "./fixtures/retail-product.mjs";

const adapterModules = await Promise.all(
  listChannels().map(({ id }) => import(`../../integrations/channels/${id}/adapter.mjs`)),
);
const adapters = new Map(adapterModules.map((adapter) => [adapter.channelId, adapter]));

const masters = [
  createMasterPackage(automotiveToMasterInput({
    businessId: "auto-city", vehicle: automotiveVehicle, media: automotiveMedia,
  })),
  createMasterPackage(retailToMasterInput({
    businessId: "dexters-hats", product: retailProduct, media: retailMedia,
  })),
];

test("all eleven adapters prepare isolated drafts for both verticals", () => {
  assert.equal(adapters.size, 11);

  for (const master of masters) {
    for (const channel of listChannels()) {
      const draft = createChannelDraft(master, channel.id);
      assert.equal(draft.business_id, master.business_id);
      assert.equal(draft.channel_id, channel.id);
      assert.ok(draft.draft_id);
      assert.ok(Array.isArray(draft.warnings));

      const originalDescription = master.description;
      draft.description = "Channel-specific copy";
      assert.equal(master.description, originalDescription);

      const prepared = adapters.get(channel.id).prepare({
        masterPackage: master, draft, context: { shadowOnly: true },
      });
      assert.equal(prepared.channel_id, channel.id);
      assert.equal(prepared.delivery_mode, channel.deliveryMode);
      assert.equal(prepared.implementation_status, channel.implementationStatus);
      assert.equal(prepared.payload.business_id, master.business_id);
      assert.ok(Array.isArray(prepared.instructions));
    }
  }
});

test("unsupported media is omitted and reported rather than invented", () => {
  const draft = createChannelDraft(masters[0], "etsy", {
    category: "Cars",
    calls_to_action: [{ label: "Buy", url: "https://example.com" }],
  });
  assert.deepEqual(draft.media, []);
  assert.equal(draft.category, null);
  assert.deepEqual(draft.calls_to_action, []);
  assert.match(draft.warnings.join(" "), /media/i);
  assert.match(draft.warnings.join(" "), /categor/i);
  assert.match(draft.warnings.join(" "), /calls to action/i);
});

test("Marketplace is assisted and distinct from the shadow-only Page adapter", () => {
  const master = masters[0];
  const marketplaceDraft = createChannelDraft(master, "facebook-marketplace");
  const pageDraft = createChannelDraft(master, "facebook-page");
  const marketplace = adapters.get("facebook-marketplace").prepare({ masterPackage: master, draft: marketplaceDraft, context: {} });
  const page = adapters.get("facebook-page").prepare({ masterPackage: master, draft: pageDraft, context: {} });

  assert.equal(marketplace.delivery_mode, "assisted");
  assert.match(marketplace.instructions.join(" "), /assisted|manually/i);
  assert.equal(marketplace.payload.listing.title, master.title);
  assert.equal(page.delivery_mode, "direct");
  assert.equal(page.payload.shadow_only, true);
  assert.equal(page.payload.message, master.description);
  assert.deepEqual(page.payload.image_data_urls, []);
  assert.notDeepEqual(marketplace.payload, page.payload);
});

test("Instagram prepares preview media without treating local data as publishable", () => {
  const instagram = adapters.get("instagram");
  const cases = [
    { url: "data:image/png;base64,AAAA", expected: "preview_only", ready: false },
    { url: "https://cdn.example.com/hat.jpg", expected: "remotely_retrievable", ready: true },
  ];
  for (const item of cases) {
    const master = createMasterPackage(retailToMasterInput({
      businessId: "dexters-hats",
      product: retailProduct,
      media: [{ id: "hero", type: "image", url: item.url, approved: true }],
    }));
    const prepared = instagram.prepare({ masterPackage: master, draft: createChannelDraft(master, "instagram"), context: { shadowOnly: true } });
    assert.equal(prepared.payload.shadow_only, true);
    assert.equal(prepared.preview.media[0].readiness, item.expected);
    assert.equal(prepared.publish_readiness.ready, item.ready);
    assert.equal(prepared.live_sent, false);
  }
});

test("Instagram reports missing media as a readiness blocker", () => {
  const master = createMasterPackage(retailToMasterInput({ businessId: "dexters-hats", product: retailProduct, media: [] }));
  const prepared = adapters.get("instagram").prepare({ masterPackage: master, draft: createChannelDraft(master, "instagram"), context: {} });
  assert.equal(prepared.publish_readiness.ready, false);
  assert.match(prepared.publish_readiness.blockers.join(" "), /image/i);
});
