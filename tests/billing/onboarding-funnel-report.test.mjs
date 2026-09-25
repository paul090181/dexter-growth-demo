import assert from "node:assert/strict";
import test from "node:test";

import { createOnboardingFunnelReportHandler } from "../../netlify/functions/onboarding-funnel-report.mjs";

function request(key = "admin") {
  return new Request("https://preview.example/.netlify/functions/onboarding-funnel-report", {
    headers: { "x-growthwise-key": key },
  });
}

const rows = [
  {
    business_id: "alpha",
    workspace_created_at: "2026-09-25T10:00:00.000Z",
    checkout_started_at: "2026-09-25T10:02:00.000Z",
    checkout_completed_at: "2026-09-25T10:04:00.000Z",
    workspace_opened_at: "2026-09-25T10:05:00.000Z",
    square_connect_started_at: "2026-09-25T10:06:00.000Z",
    square_connected_at: "2026-09-25T10:08:00.000Z",
    business_pulse_loaded_at: "2026-09-25T10:09:00.000Z",
    ai_workflow_used_at: null,
    first_value_at: "2026-09-25T10:09:00.000Z",
    workspace_open_days: 2,
    returned_after_first_value: true,
    campaign_code: "LAUNCH20",
    source_channel: "pilot",
    campaign_name: "Launch",
    current_plan_key: "growth_monthly",
    subscription_status: "active",
  },
  {
    business_id: "beta",
    workspace_created_at: "2026-09-25T11:00:00.000Z",
    checkout_started_at: "2026-09-25T11:03:00.000Z",
    checkout_completed_at: null,
    workspace_opened_at: "2026-09-25T11:01:00.000Z",
    square_connect_started_at: null,
    square_connected_at: null,
    business_pulse_loaded_at: null,
    ai_workflow_used_at: "2026-09-25T11:15:00.000Z",
    first_value_at: "2026-09-25T11:15:00.000Z",
    workspace_open_days: 1,
    returned_after_first_value: false,
    campaign_code: null,
    source_channel: null,
    campaign_name: null,
    current_plan_key: "starter_monthly",
    subscription_status: "active",
  },
];

test("onboarding funnel report is admin-only", async () => {
  const handler = createOnboardingFunnelReportHandler({
    isAuthorized: (req) => ({ ok: req.headers.get("x-growthwise-key") === "admin" }),
    store: { listFunnelRows: async () => rows },
  });
  assert.equal((await handler(request("wrong"))).status, 401);
});

test("onboarding funnel report summarizes conversion, attribution, return, and time to value", async () => {
  const handler = createOnboardingFunnelReportHandler({
    isAuthorized: () => ({ ok: true }),
    store: { listFunnelRows: async () => rows },
  });

  const response = await handler(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.overall.tenants_observed, 2);
  assert.equal(body.overall.stages.workspace_created, 2);
  assert.equal(body.overall.stages.checkout_completed, 1);
  assert.equal(body.overall.stages.business_pulse_loaded, 1);
  assert.equal(body.overall.stages.ai_workflow_used, 1);
  assert.equal(body.overall.first_value_reached, 2);
  assert.equal(body.overall.returned_after_first_value, 1);
  assert.equal(body.overall.time_to_first_value_minutes.minimum, 9);
  assert.equal(body.overall.time_to_first_value_minutes.maximum, 15);
  assert.equal(body.overall.time_to_first_value_minutes.median, 9);

  const launch = body.campaigns.find((row) => row.campaign_code === "LAUNCH20");
  assert.equal(launch.tenants_observed, 1);
  assert.equal(launch.first_value_reached, 1);
  assert.equal(launch.source_channel, "pilot");

  const unattributed = body.campaigns.find((row) => row.campaign_code === "UNATTRIBUTED");
  assert.equal(unattributed.tenants_observed, 1);

  assert.equal(body.tenants[0].time_to_first_value_minutes, 9);
  assert.equal(body.tenants[0].returned_after_first_value, true);
  assert.match(body.privacy_note, /no customer message text/i);
});
