import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyFailure,
  createPublishingJob,
  idempotencyKey,
  retryDecision,
  transitionJob,
} from "../../core/publishing/orchestration/jobs.mjs";

const input = {
  businessId: "auto-city",
  masterId: "vehicle-42",
  draftId: "draft-facebook",
  channelId: "facebook-page",
  action: "publish:create",
  revision: 1,
};

test("idempotency keys are deterministic, revision-aware, action-aware, and tenant-scoped", () => {
  assert.equal(idempotencyKey(input), idempotencyKey({ ...input }));
  assert.notEqual(idempotencyKey(input), idempotencyKey({ ...input, revision: 2 }));
  assert.notEqual(idempotencyKey(input), idempotencyKey({ ...input, action: "publish:republish" }));
  assert.notEqual(idempotencyKey(input), idempotencyKey({ ...input, businessId: "dexters-hats" }));
});

test("jobs contain their tenant scope and stable duplicate-protection key", () => {
  const job = createPublishingJob(input);
  assert.equal(job.business_id, input.businessId);
  assert.equal(job.master_id, input.masterId);
  assert.equal(job.channel_id, input.channelId);
  assert.equal(job.status, "Draft");
  assert.equal(job.attempts, 0);
  assert.equal(job.idempotency_key, idempotencyKey(input));
});

test("temporary timeout and rate-limit failures retry only within the bound", () => {
  for (const error of [
    Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }),
    Object.assign(new Error("too many requests"), { status: 429 }),
  ]) {
    const failure = classifyFailure(error);
    assert.equal(failure.type, "temporary");
    assert.equal(failure.retryable, true);
    assert.equal(retryDecision({ attempts: 1 }, failure, 3).nextStatus, "Retry Scheduled");
    assert.equal(retryDecision({ attempts: 3 }, failure, 3).nextStatus, "Needs Attention");
  }
});

test("category, permission, and approval failures are business rules and never retry", () => {
  for (const error of [
    Object.assign(new Error("missing category"), { code: "MISSING_CATEGORY" }),
    Object.assign(new Error("permission denied"), { code: "PERMISSION_DENIED" }),
    Object.assign(new Error("approval required"), { code: "APPROVAL_REQUIRED" }),
  ]) {
    const failure = classifyFailure(error);
    assert.equal(failure.type, "business_rule");
    assert.equal(failure.retryable, false);
    assert.equal(retryDecision({ attempts: 0 }, failure).nextStatus, "Needs Attention");
    assert.ok(failure.userMessage);
  }
});

test("transitioning one channel is immutable and cannot cross tenant boundaries", () => {
  const failed = createPublishingJob(input);
  const sibling = createPublishingJob({ ...input, draftId: "draft-instagram", channelId: "instagram" });
  const changed = transitionJob(failed, "Needs Attention", { failure: { type: "business_rule" } });

  assert.equal(changed.status, "Needs Attention");
  assert.equal(failed.status, "Draft");
  assert.equal(sibling.status, "Draft");
  assert.throws(
    () => transitionJob(failed, "Queued", { business_id: "dexters-hats" }),
    /business_id/i,
  );
});
