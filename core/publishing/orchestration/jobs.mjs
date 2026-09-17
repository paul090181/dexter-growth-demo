import { createHash, randomUUID } from "node:crypto";

import { JOB_STATUSES } from "../constants.mjs";

const REQUIRED_KEY_FIELDS = ["businessId", "masterId", "channelId", "action", "revision"];

const TRANSITIONS = Object.freeze({
  Draft: ["Waiting Approval", "Queued", "Processing", "Failed", "Needs Attention"],
  "Waiting Approval": ["Draft", "Queued", "Processing", "Failed", "Needs Attention"],
  Queued: ["Processing", "Retry Scheduled", "Failed", "Needs Attention"],
  Processing: ["Published", "Retry Scheduled", "Failed", "Needs Attention"],
  Published: ["Removed"],
  "Retry Scheduled": ["Queued", "Processing", "Failed", "Needs Attention"],
  "Needs Attention": ["Draft", "Waiting Approval", "Queued"],
  Failed: ["Retry Scheduled", "Needs Attention"],
  Removed: [],
});

function requireValue(value, name) {
  if (value === undefined || value === null || value === "") {
    throw new TypeError(`${name} is required`);
  }
}

export function idempotencyKey(input = {}) {
  for (const field of REQUIRED_KEY_FIELDS) requireValue(input[field], field);
  const canonical = JSON.stringify(REQUIRED_KEY_FIELDS.map((field) => input[field]));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function createPublishingJob({
  businessId,
  masterId,
  draftId,
  channelId,
  action,
  revision,
} = {}) {
  requireValue(draftId, "draftId");
  const keyInput = { businessId, masterId, channelId, action, revision };
  const now = new Date().toISOString();
  return {
    job_id: randomUUID(),
    business_id: businessId,
    master_id: masterId,
    draft_id: draftId,
    channel_id: channelId,
    action,
    revision,
    idempotency_key: idempotencyKey(keyInput),
    status: "Draft",
    attempts: 0,
    created_at: now,
    updated_at: now,
  };
}

export function transitionJob(job, nextStatus, patch = {}) {
  if (!job?.business_id) throw new TypeError("job.business_id is required");
  if (!JOB_STATUSES.includes(nextStatus)) throw new RangeError(`Unknown job status: ${nextStatus}`);
  if (patch.business_id !== undefined && patch.business_id !== job.business_id) {
    throw new Error("A job's business_id cannot be changed");
  }
  if (nextStatus !== job.status && !TRANSITIONS[job.status]?.includes(nextStatus)) {
    throw new Error(`Invalid job status transition: ${job.status} -> ${nextStatus}`);
  }

  return {
    ...structuredClone(job),
    ...structuredClone(patch),
    business_id: job.business_id,
    status: nextStatus,
    updated_at: new Date().toISOString(),
  };
}

const BUSINESS_RULES = new Map([
  ["MISSING_CATEGORY", "This channel needs a category before the listing can be prepared."],
  ["PERMISSION_DENIED", "The current account does not have permission for this publishing action."],
  ["APPROVAL_REQUIRED", "This publishing action needs approval before it can continue."],
]);

export function classifyFailure(error) {
  const code = String(error?.code ?? "").toUpperCase();
  const status = Number(error?.status ?? error?.statusCode);
  const message = String(error?.message ?? error ?? "Unknown publishing failure");
  const lowerMessage = message.toLowerCase();

  const businessCode = BUSINESS_RULES.has(code)
    ? code
    : lowerMessage.includes("category") ? "MISSING_CATEGORY"
      : lowerMessage.includes("permission") || status === 401 || status === 403 ? "PERMISSION_DENIED"
        : lowerMessage.includes("approval") ? "APPROVAL_REQUIRED" : null;
  if (businessCode) {
    return { type: "business_rule", retryable: false, userMessage: BUSINESS_RULES.get(businessCode) };
  }

  const temporary = status === 429 || status >= 500
    || ["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "RATE_LIMITED"].includes(code)
    || /timed? out|rate.?limit|too many requests|temporar(?:y|ily)/i.test(message);
  if (temporary) {
    return {
      type: "temporary",
      retryable: true,
      userMessage: status === 429 || /rate.?limit|too many requests/i.test(message)
        ? "The channel is rate-limiting requests. GrowthWise will retry automatically."
        : "The channel is temporarily unavailable. GrowthWise will retry automatically.",
    };
  }

  return {
    type: "permanent",
    retryable: false,
    userMessage: "This channel could not prepare the listing and needs attention.",
  };
}

export function retryDecision(job, failure, maxAttempts = 3) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  const attempts = Number(job?.attempts ?? job?.attempt_count ?? 0);
  const shouldRetry = failure?.retryable === true && attempts < maxAttempts;
  return {
    retry: shouldRetry,
    shouldRetry,
    nextStatus: shouldRetry ? "Retry Scheduled" : "Needs Attention",
    nextAttempt: shouldRetry ? attempts + 1 : null,
    attemptsRemaining: Math.max(0, maxAttempts - attempts),
  };
}
