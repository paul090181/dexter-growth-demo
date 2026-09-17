import test from "node:test";
import assert from "node:assert/strict";

import { authorizeRole } from "../../core/publishing/automation/permissions.mjs";
import { resolveAutomationLevel } from "../../core/publishing/automation/policy.mjs";
import { getChannel, listChannels } from "../../core/publishing/channels/registry.mjs";
import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { compareProtectedFacts } from "../../core/publishing/master-package/facts.mjs";
import { validateMasterPackage } from "../../core/publishing/master-package/validate.mjs";
import {
  classifyFailure,
  createPublishingJob,
  idempotencyKey,
  retryDecision,
} from "../../core/publishing/orchestration/jobs.mjs";
import { runShadowPublishing } from "../../core/publishing/orchestration/shadow.mjs";
import { automotiveToMasterInput } from "../../verticals/automotive/publishing-adapter/index.mjs";
import { retailToMasterInput } from "../../verticals/retail/publishing-adapter/index.mjs";
import { automotiveMedia, automotiveVehicle } from "./fixtures/automotive-vehicle.mjs";
import { retailMedia, retailProduct } from "./fixtures/retail-product.mjs";

const automotiveMaster = createMasterPackage(automotiveToMasterInput({
  businessId: "auto-city",
  vehicle: automotiveVehicle,
  media: automotiveMedia,
  business: { name: "Auto City" },
}));
const retailMaster = createMasterPackage(retailToMasterInput({
  businessId: "dexters-hats",
  product: retailProduct,
  media: retailMedia,
  business: { name: "Dexter's Hats" },
}));

test("both pilot verticals produce valid, tenant-scoped master packages", () => {
  assert.deepEqual(validateMasterPackage(automotiveMaster), { ok: true, errors: [] });
  assert.deepEqual(validateMasterPackage(retailMaster), { ok: true, errors: [] });
  assert.equal(automotiveMaster.business_id, "auto-city");
  assert.equal(retailMaster.business_id, "dexters-hats");
});

test("the eleven-channel registry keeps Marketplace separate and Assisted", () => {
  const channels = listChannels();
  assert.equal(channels.length, 11);
  assert.equal(new Set(channels.map(({ id }) => id)).size, 11);
  assert.equal(getChannel("facebook-marketplace").deliveryMode, "assisted");
  assert.notDeepEqual(getChannel("facebook-marketplace"), getChannel("facebook-page"));
  assert.ok(channels.every(({ deliveryMode }) => ["direct", "assisted", "export"].includes(deliveryMode)));
});

test("protected fact mutation remains blocked at the acceptance boundary", () => {
  const changed = {
    ...automotiveMaster,
    verified_facts: { ...automotiveMaster.verified_facts, price: 1 },
  };
  const comparison = compareProtectedFacts(automotiveMaster, changed);
  assert.equal(comparison.ok, false);
  assert.match(comparison.errors.join(" "), /price/i);
});

test("automation precedence and role checks fail closed", () => {
  const config = {
    publishing: {
      automation: {
        default: "review",
        channels: { website: "automatic" },
        actions: { "publish:remove": "manual" },
      },
    },
  };
  assert.equal(resolveAutomationLevel(config, "instagram", "publish:create"), "review");
  assert.equal(resolveAutomationLevel(config, "website", "publish:create"), "automatic");
  assert.equal(resolveAutomationLevel(config, "website", "publish:remove"), "manual");
  assert.equal(authorizeRole("owner_admin", "publish:auto").allowed, true);
  assert.equal(authorizeRole("staff", "publish:auto").allowed, false);
  assert.equal(authorizeRole("view_only", "publish:request").allowed, false);
});

test("cross-business orchestration is rejected before channel work", async () => {
  await assert.rejects(
    runShadowPublishing({
      businessId: "dexters-hats",
      role: "owner_admin",
      masterPackage: automotiveMaster,
      channelIds: ["website"],
    }),
    /tenant mismatch/i,
  );
});

test("a channel failure is isolated and every shadow result denies a live send", async () => {
  const run = await runShadowPublishing({
    businessId: "auto-city",
    role: "owner_admin",
    masterPackage: automotiveMaster,
    clientConfig: { publishing: { automation: { default: "review" } } },
    channelIds: ["website", "not-a-channel", "ebay"],
  });

  assert.equal(run.mode, "shadow");
  assert.deepEqual(run.results.map(({ status }) => status), ["Waiting Approval", "Failed", "Waiting Approval"]);
  assert.ok(run.results.every(({ live_sent: liveSent }) => liveSent === false));
});

test("temporary retries are bounded and duplicate-safe", () => {
  const input = {
    businessId: "auto-city",
    masterId: automotiveMaster.source.id,
    draftId: "acceptance-draft",
    channelId: "website",
    action: "publish:create",
    revision: 1,
  };
  const first = createPublishingJob(input);
  const duplicate = createPublishingJob(input);
  const failure = classifyFailure(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));

  assert.equal(first.idempotency_key, duplicate.idempotency_key);
  assert.equal(first.idempotency_key, idempotencyKey(input));
  assert.equal(retryDecision({ ...first, attempts: 2 }, failure, 3).nextStatus, "Retry Scheduled");
  assert.equal(retryDecision({ ...first, attempts: 3 }, failure, 3).nextStatus, "Needs Attention");
});
