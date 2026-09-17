import test from "node:test";
import assert from "node:assert/strict";

import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { runShadowPublishing } from "../../core/publishing/orchestration/shadow.mjs";
import { automotiveToMasterInput } from "../../verticals/automotive/publishing-adapter/index.mjs";
import { retailToMasterInput } from "../../verticals/retail/publishing-adapter/index.mjs";
import { automotiveMedia, automotiveVehicle } from "./fixtures/automotive-vehicle.mjs";
import { retailMedia, retailProduct } from "./fixtures/retail-product.mjs";

const automotiveMaster = createMasterPackage(automotiveToMasterInput({
  businessId: "auto-city", vehicle: automotiveVehicle, media: automotiveMedia,
}));
const retailMaster = createMasterPackage(retailToMasterInput({
  businessId: "dexters-hats", product: retailProduct, media: retailMedia,
}));
const clientConfig = {
  publishing: {
    automation: {
      default: "review",
      channels: { "facebook-marketplace": "automatic", website: "manual" },
    },
  },
};

test("shadow runs preserve tenant scope, statuses, and one audit event per attempt", async () => {
  for (const [master, businessId] of [[automotiveMaster, "auto-city"], [retailMaster, "dexters-hats"]]) {
    const run = await runShadowPublishing({
      businessId, role: "owner_admin", masterPackage: master, clientConfig,
      channelIds: ["website", "facebook-marketplace", "instagram"],
    });

    assert.equal(run.mode, "shadow");
    assert.equal(run.business_id, businessId);
    assert.equal(run.results.length, 3);
    assert.equal(run.audit_events.length, 3);
    assert.ok(run.results.every((result) => result.business_id === businessId));
    assert.ok(run.audit_events.every((event) => event.business_id === businessId));
    assert.ok(run.results.every((result) => result.live_sent === false));
    assert.equal(run.results.find(({ channel_id }) => channel_id === "website").status, "Draft");
    assert.equal(run.results.find(({ channel_id }) => channel_id === "instagram").status, "Waiting Approval");
    const marketplace = run.results.find(({ channel_id }) => channel_id === "facebook-marketplace");
    assert.equal(marketplace.status, "Queued");
    assert.equal(marketplace.prepared.delivery_mode, "assisted");
    assert.notEqual(marketplace.status, "Published");
  }
});

test("tenant and authorization checks fail before channel work", async () => {
  await assert.rejects(
    runShadowPublishing({ businessId: "dexters-hats", role: "owner_admin", masterPackage: automotiveMaster, channelIds: ["website"] }),
    /tenant mismatch/i,
  );
  await assert.rejects(
    runShadowPublishing({ businessId: "auto-city", role: "view_only", masterPackage: automotiveMaster, channelIds: ["website"] }),
    /not authorized/i,
  );
});

test("a channel error is audited without discarding successful siblings", async () => {
  const run = await runShadowPublishing({
    businessId: "auto-city", role: "manager", masterPackage: automotiveMaster,
    channelIds: ["website", "not-a-channel", "ebay"],
  });

  assert.equal(run.mode, "shadow");
  assert.equal(run.results.length, 3);
  assert.equal(run.audit_events.length, 3);
  assert.equal(run.results[0].status, "Draft");
  assert.equal(run.results[1].status, "Failed");
  assert.match(run.results[1].error.message, /unknown channel/i);
  assert.equal(run.results[2].status, "Draft");
});
