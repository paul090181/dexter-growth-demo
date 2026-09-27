import { authorized } from "./_lead-store.mjs";
import { createPilotStore } from "./_pilot-store.mjs";

const BUSINESS_ID = "dexters-hats";
const PATH = "/.netlify/functions/dexter-pilot-status";
const PREVIEW_HOST = /^deploy-preview-\d+--euphonious-beijinho-db4b4d\.netlify\.app$/;
const EVENT_NAMES = Object.freeze([
  "pilot_opened",
  "instagram_photo_selected",
  "instagram_draft_created",
  "instagram_publish_succeeded",
  "instagram_publish_failed",
  "feedback_submitted",
]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function iso(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function countMap(rows, keyField, countField, allowed) {
  const map = Object.fromEntries(allowed.map((key) => [key, 0]));
  for (const row of rows || []) {
    const key = String(row?.[keyField] || "");
    if (Object.hasOwn(map, key)) map[key] = Number(row?.[countField] || 0);
  }
  return map;
}

function latestEvent(rows) {
  let latest = null;
  for (const row of rows || []) {
    const at = row?.last_at ? new Date(row.last_at) : null;
    if (!at || !Number.isFinite(at.getTime())) continue;
    if (!latest || at.getTime() > latest.at.getTime()) {
      latest = { name: String(row.event_name || ""), at };
    }
  }
  return latest;
}

function invitationState(invitation, checkedAt) {
  if (!invitation) return "none";
  if (invitation.revoked_at) return "revoked";
  if (invitation.consumed_at) return "opened";
  const expires = invitation.expires_at ? new Date(invitation.expires_at) : null;
  if (!expires || !Number.isFinite(expires.getTime()) || expires.getTime() <= checkedAt.getTime()) {
    return "expired";
  }
  return "waiting_to_open";
}

function sessionState(session, checkedAt) {
  if (!session) return "none";
  if (session.revoked_at) return "revoked";
  const expires = session.expires_at ? new Date(session.expires_at) : null;
  if (!expires || !Number.isFinite(expires.getTime()) || expires.getTime() <= checkedAt.getTime()) {
    return "expired";
  }
  return "active";
}

export function summarizeDexterPilotStatus(raw) {
  const checkedAt = raw?.checked_at instanceof Date ? raw.checked_at : new Date(raw?.checked_at);
  if (!Number.isFinite(checkedAt.getTime())) throw new Error("INVALID_STATUS_TIME");

  const eventCounts = countMap(raw?.events, "event_name", "event_count", EVENT_NAMES);
  const feedbackCounts = countMap(
    raw?.feedback,
    "result",
    "feedback_count",
    ["worked", "needs-improvement"],
  );
  const latest = latestEvent(raw?.events);
  const totalEvents = Object.values(eventCounts).reduce((sum, count) => sum + count, 0);
  const totalFeedback = Object.values(feedbackCounts).reduce((sum, count) => sum + count, 0);

  let stage = "not_invited";
  let stageLabel = "No pilot activity yet";
  if (raw?.invitation) {
    stage = "invited";
    stageLabel = "Pilot link created";
  }
  if (eventCounts.pilot_opened > 0 || raw?.invitation?.consumed_at) {
    stage = "opened";
    stageLabel = "Dexter opened the pilot";
  }
  if (eventCounts.instagram_photo_selected > 0) {
    stage = "photo_selected";
    stageLabel = "Dexter selected a hat photo";
  }
  if (eventCounts.instagram_draft_created > 0) {
    stage = "draft_ready";
    stageLabel = "Dexter created an Instagram draft";
  }
  if (eventCounts.instagram_publish_failed > 0) {
    stage = "publish_attention";
    stageLabel = "A publish attempt needs attention";
  }
  if (eventCounts.instagram_publish_succeeded > 0) {
    stage = "published";
    stageLabel = "Dexter completed an Instagram post";
  }
  if (eventCounts.feedback_submitted > 0 || totalFeedback > 0) {
    stage = eventCounts.instagram_publish_succeeded > 0 ? "completed_with_feedback" : stage;
    if (stage === "completed_with_feedback") stageLabel = "Dexter completed the pilot and left feedback";
  }

  const followUps = {
    not_invited: "Create a fresh pilot link only when you are ready to start the test.",
    invited: "The link has not been opened yet. Give Dexter time unless he says the link is not working.",
    opened: "Dexter opened the pilot. If he stops here, ask whether the first screen and next step were clear.",
    photo_selected: "Dexter selected a photo. If he stops here, ask whether creating the draft was clear.",
    draft_ready: "Dexter reached a draft but has not completed a post. Ask what, if anything, made him hesitate before publishing.",
    publish_attention: "A publish attempt needs attention. Offer to troubleshoot the Instagram connection instead of asking him to retry repeatedly.",
    published: "Dexter completed a post. Ask how easy it felt and what task he would want Narleo to handle next.",
    completed_with_feedback: "Review his feedback signal, then ask one specific follow-up about the next workflow he would value.",
  };

  const feedbackLast = (raw?.feedback || [])
    .map((row) => ({
      result: String(row?.result || ""),
      at: row?.last_at ? new Date(row.last_at) : null,
    }))
    .filter((row) => row.at && Number.isFinite(row.at.getTime()))
    .sort((a, b) => b.at.getTime() - a.at.getTime())[0] || null;

  return {
    business_id: BUSINESS_ID,
    checked_at: checkedAt.toISOString(),
    stage,
    stage_label: stageLabel,
    recommended_follow_up: followUps[stage] || "",
    invitation: {
      state: invitationState(raw?.invitation, checkedAt),
      created_at: iso(raw?.invitation?.created_at),
      expires_at: iso(raw?.invitation?.expires_at),
      opened_at: iso(raw?.invitation?.consumed_at),
    },
    session: {
      state: sessionState(raw?.session, checkedAt),
      created_at: iso(raw?.session?.created_at),
      expires_at: iso(raw?.session?.expires_at),
    },
    activity: {
      total_events: totalEvents,
      counts: eventCounts,
      first_opened_at: iso((raw?.events || []).find((row) => row?.event_name === "pilot_opened")?.first_at),
      last_activity_at: latest ? latest.at.toISOString() : null,
      last_event: latest?.name || null,
    },
    feedback: {
      total: totalFeedback,
      worked: feedbackCounts.worked,
      needs_improvement: feedbackCounts["needs-improvement"],
      last_result: feedbackLast?.result || null,
      last_at: feedbackLast ? feedbackLast.at.toISOString() : null,
    },
    privacy_note: "Status contains milestone counts and timestamps only. It does not include photos, captions, customer data, provider tokens, or feedback notes.",
  };
}

export function createDexterPilotStatusHandler({
  isAuthorized = authorized,
  store = createPilotStore(),
  now = () => new Date(),
} = {}) {
  return async function dexterPilotStatus(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); }
    catch { return json(400, { error: "Invalid request." }); }

    if (url.protocol !== "https:"
      || !PREVIEW_HOST.test(url.hostname)
      || url.pathname !== PATH
      || url.search
      || url.hash) {
      return json(404, { error: "Pilot status is not available here." });
    }

    if (!isAuthorized(request)?.ok) return json(401, { error: "Unauthorized." });

    const checkedAt = now();
    try {
      const raw = await store.readBusinessStatus({
        businessId: BUSINESS_ID,
        now: checkedAt,
      });
      return json(200, {
        ok: true,
        ...summarizeDexterPilotStatus(raw),
      });
    } catch {
      return json(503, { error: "Dexter pilot status is temporarily unavailable." });
    }
  };
}

export default function handler(request) {
  return createDexterPilotStatusHandler()(request);
}
