import { createAuditEvent } from "../audit/events.mjs";
import { authorizeRole } from "../automation/permissions.mjs";
import { resolveAutomationLevel } from "../automation/policy.mjs";
import { createChannelDraft } from "../channels/draft.mjs";
import { validateMasterPackage } from "../master-package/validate.mjs";
import { createPublishingJob } from "./jobs.mjs";

const STATUS_BY_AUTOMATION = Object.freeze({
  manual: "Draft",
  review: "Waiting Approval",
  automatic: "Queued",
});

function masterId(masterPackage) {
  return masterPackage.master_id ?? masterPackage.id ?? masterPackage.source?.id ?? null;
}

function permissionFor(action) {
  if (action === "publish:auto") return action;
  if (action.startsWith("publish:")) return "publish:request";
  return action;
}

function publicError(error) {
  return {
    name: error?.name ?? "Error",
    message: String(error?.message ?? error ?? "Unknown channel error"),
    ...(error?.code === undefined ? {} : { code: error.code }),
  };
}

async function prepareChannel(channelId, input) {
  const adapter = await import(`../../../integrations/channels/${channelId}/adapter.mjs`);
  if (adapter.channelId !== channelId || typeof adapter.prepare !== "function") {
    throw new TypeError(`Invalid adapter for channel: ${channelId}`);
  }
  return adapter.prepare(input);
}

/**
 * Exercise the complete publishing pipeline without performing a live send.
 * A channel attempt is isolated so a broken adapter cannot discard its siblings.
 */
export async function runShadowPublishing({
  businessId,
  role,
  masterPackage,
  clientConfig,
  channelIds,
  action = "publish:create",
} = {}) {
  if (businessId !== masterPackage?.business_id) {
    throw new Error("Publishing tenant mismatch: businessId must match masterPackage.business_id");
  }

  const validation = validateMasterPackage(masterPackage);
  if (!validation.ok) throw new TypeError(`Invalid master package: ${validation.errors.join("; ")}`);

  const authorization = authorizeRole(role, permissionFor(action));
  if (!authorization.allowed) throw new Error(authorization.reason);
  if (!Array.isArray(channelIds)) throw new TypeError("channelIds must be an array");

  const id = masterId(masterPackage);
  const results = [];
  const auditEvents = [];

  for (const channelId of channelIds) {
    const configuredAutomationLevel = resolveAutomationLevel(clientConfig, channelId, action);
    const canPublishAutomatically = authorizeRole(role, "publish:auto").allowed;
    const automationLevel = configuredAutomationLevel === "automatic" && !canPublishAutomatically
      ? "review"
      : configuredAutomationLevel;
    let result;
    try {
      const draft = createChannelDraft(masterPackage, channelId);
      const job = createPublishingJob({
        businessId,
        masterId: id,
        draftId: draft.draft_id,
        channelId,
        action,
        revision: masterPackage.revision ?? 1,
      });
      const prepared = await prepareChannel(channelId, {
        masterPackage,
        draft,
        context: { shadowOnly: true, businessId, role, action },
      });
      result = {
        business_id: businessId,
        master_id: id,
        channel_id: channelId,
        automation_level: automationLevel,
        status: STATUS_BY_AUTOMATION[automationLevel],
        live_sent: false,
        draft,
        job: { ...job, status: STATUS_BY_AUTOMATION[automationLevel] },
        prepared,
      };
    } catch (error) {
      result = {
        business_id: businessId,
        master_id: id,
        channel_id: channelId,
        automation_level: automationLevel,
        status: "Failed",
        live_sent: false,
        error: publicError(error),
      };
    }

    results.push(result);
    auditEvents.push(createAuditEvent({
      businessId,
      actor: { role },
      action,
      entityType: "publishing_channel_attempt",
      entityId: `${id}:${channelId}`,
      details: {
        master_id: id,
        channel_id: channelId,
        automation_level: automationLevel,
        status: result.status,
        live_sent: false,
        ...(result.error ? { error: result.error } : {}),
      },
    }));
  }

  return {
    mode: "shadow",
    business_id: businessId,
    master_id: id,
    results,
    audit_events: auditEvents,
  };
}
