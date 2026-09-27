import assert from "node:assert/strict";
import test from "node:test";

import {
  createDexterPilotStatusHandler,
  summarizeDexterPilotStatus,
} from "../../netlify/functions/dexter-pilot-status.mjs";
import { createPilotStore } from "../../netlify/functions/_pilot-store.mjs";

const ORIGIN = "https://deploy-preview-18--euphonious-beijinho-db4b4d.netlify.app";
const NOW = new Date("2026-09-27T16:30:00.000Z");

function raw(overrides = {}) {
  return {
    business_id: "dexters-hats",
    checked_at: NOW,
    invitation: {
      created_at: new Date("2026-09-27T14:00:00.000Z"),
      expires_at: new Date("2026-09-30T14:00:00.000Z"),
      consumed_at: new Date("2026-09-27T14:15:00.000Z"),
      revoked_at: null,
    },
    session: {
      created_at: new Date("2026-09-27T14:15:00.000Z"),
      expires_at: new Date("2026-10-27T14:15:00.000Z"),
      revoked_at: null,
    },
    events: [
      {
        event_name: "pilot_opened",
        event_count: 1,
        first_at: new Date("2026-09-27T14:16:00.000Z"),
        last_at: new Date("2026-09-27T14:16:00.000Z"),
      },
      {
        event_name: "instagram_photo_selected",
        event_count: 1,
        first_at: new Date("2026-09-27T14:20:00.000Z"),
        last_at: new Date("2026-09-27T14:20:00.000Z"),
      },
      {
        event_name: "instagram_draft_created",
        event_count: 1,
        first_at: new Date("2026-09-27T14:22:00.000Z"),
        last_at: new Date("2026-09-27T14:22:00.000Z"),
      },
      {
        event_name: "instagram_publish_succeeded",
        event_count: 1,
        first_at: new Date("2026-09-27T14:25:00.000Z"),
        last_at: new Date("2026-09-27T14:25:00.000Z"),
      },
      {
        event_name: "feedback_submitted",
        event_count: 1,
        first_at: new Date("2026-09-27T14:27:00.000Z"),
        last_at: new Date("2026-09-27T14:27:00.000Z"),
      },
    ],
    feedback: [{
      result: "worked",
      feedback_count: 1,
      last_at: new Date("2026-09-27T14:27:00.000Z"),
      note: "must-not-leak",
    }],
    ...overrides,
  };
}

test("Dexter pilot status summarizes milestones without feedback notes or content", () => {
  const status = summarizeDexterPilotStatus(raw());
  assert.equal(status.business_id, "dexters-hats");
  assert.equal(status.stage, "completed_with_feedback");
  assert.equal(status.stage_label, "Dexter completed the pilot and left feedback");
  assert.equal(status.invitation.state, "opened");
  assert.equal(status.session.state, "active");
  assert.equal(status.activity.total_events, 5);
  assert.equal(status.activity.counts.instagram_publish_succeeded, 1);
  assert.equal(status.activity.last_event, "feedback_submitted");
  assert.equal(status.feedback.total, 1);
  assert.equal(status.feedback.worked, 1);
  assert.equal(status.feedback.last_result, "worked");
  assert.equal(JSON.stringify(status).includes("must-not-leak"), false);
  assert.match(status.privacy_note, /does not include photos, captions/i);
});

test("Dexter pilot status distinguishes waiting, opened, draft, and publish-attention stages", () => {
  const waiting = summarizeDexterPilotStatus(raw({
    invitation: {
      created_at: new Date("2026-09-27T16:00:00.000Z"),
      expires_at: new Date("2026-09-30T16:00:00.000Z"),
      consumed_at: null,
      revoked_at: null,
    },
    session: null,
    events: [],
    feedback: [],
  }));
  assert.equal(waiting.stage, "invited");
  assert.equal(waiting.invitation.state, "waiting_to_open");

  const opened = summarizeDexterPilotStatus(raw({
    events: [{
      event_name: "pilot_opened",
      event_count: 1,
      first_at: NOW,
      last_at: NOW,
    }],
    feedback: [],
  }));
  assert.equal(opened.stage, "opened");

  const draft = summarizeDexterPilotStatus(raw({
    events: [
      { event_name: "pilot_opened", event_count: 1, first_at: NOW, last_at: NOW },
      { event_name: "instagram_draft_created", event_count: 1, first_at: NOW, last_at: NOW },
    ],
    feedback: [],
  }));
  assert.equal(draft.stage, "draft_ready");

  const attention = summarizeDexterPilotStatus(raw({
    events: [
      { event_name: "pilot_opened", event_count: 1, first_at: NOW, last_at: NOW },
      { event_name: "instagram_publish_failed", event_count: 1, first_at: NOW, last_at: NOW },
    ],
    feedback: [],
  }));
  assert.equal(attention.stage, "publish_attention");
});

test("Dexter pilot status endpoint is preview-only and admin-gated", async () => {
  let reads = 0;
  const handler = createDexterPilotStatusHandler({
    isAuthorized: (request) => ({
      ok: request.headers.get("x-growthwise-key") === "admin",
    }),
    store: {
      async readBusinessStatus() {
        reads += 1;
        return raw();
      },
    },
    now: () => NOW,
  });

  const unauthorized = await handler(new Request(
    ORIGIN + "/.netlify/functions/dexter-pilot-status",
  ));
  assert.equal(unauthorized.status, 401);
  assert.equal(reads, 0);

  const production = await handler(new Request(
    "https://euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/dexter-pilot-status",
    { headers: { "x-growthwise-key": "admin" } },
  ));
  assert.equal(production.status, 404);
  assert.equal(reads, 0);

  const response = await handler(new Request(
    ORIGIN + "/.netlify/functions/dexter-pilot-status",
    { headers: { "x-growthwise-key": "admin" } },
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.business_id, "dexters-hats");
  assert.equal(body.stage, "completed_with_feedback");
  assert.equal(reads, 1);
});

test("pilot store reads only safe status metadata for one fixed business", async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes("growthwise_pilot_invitations")) {
        return { rows: [{
          created_at: NOW,
          expires_at: new Date(NOW.getTime() + 1000),
          consumed_at: NOW,
          revoked_at: null,
        }] };
      }
      if (sql.includes("growthwise_pilot_sessions")) {
        return { rows: [{
          created_at: NOW,
          expires_at: new Date(NOW.getTime() + 1000),
          revoked_at: null,
        }] };
      }
      if (sql.includes("growthwise_pilot_events")) {
        return { rows: [{
          event_name: "pilot_opened",
          event_count: 1,
          first_at: NOW,
          last_at: NOW,
        }] };
      }
      if (sql.includes("growthwise_pilot_feedback")) {
        return { rows: [{
          result: "worked",
          feedback_count: 1,
          last_at: NOW,
        }] };
      }
      throw new Error("unexpected query");
    },
  };
  const store = createPilotStore({ getPool: async () => pool });
  const status = await store.readBusinessStatus({
    businessId: "dexters-hats",
    now: NOW,
  });

  assert.equal(status.business_id, "dexters-hats");
  assert.equal(queries.length, 4);
  assert.equal(queries.every((query) => query.values[0] === "dexters-hats"), true);
  assert.equal(queries.some((query) => /\bnote\b/i.test(query.sql)), false);
  assert.equal(queries.some((query) => /session_hash|invitation_hash/i.test(query.sql)), false);
});
