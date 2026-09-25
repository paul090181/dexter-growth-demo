import { authorized, json } from "./_lead-store.mjs";
import { createOnboardingAnalyticsStore } from "./_onboarding-analytics-store.mjs";

const STAGES = [
  ["workspace_created", "workspace_created_at"],
  ["checkout_started", "checkout_started_at"],
  ["checkout_completed", "checkout_completed_at"],
  ["workspace_opened", "workspace_opened_at"],
  ["square_connect_started", "square_connect_started_at"],
  ["square_connected", "square_connected_at"],
  ["business_pulse_loaded", "business_pulse_loaded_at"],
  ["ai_workflow_used", "ai_workflow_used_at"],
];

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function durationMinutes(start, end) {
  const a = start ? new Date(start) : null;
  const b = end ? new Date(end) : null;
  if (!a || !b || !Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b < a) return null;
  return Math.round((b.getTime() - a.getTime()) / 60000);
}

function summarize(rows) {
  const tenants = rows || [];
  const stageCounts = Object.fromEntries(STAGES.map(([name, field]) => [
    name,
    tenants.filter((row) => Boolean(row[field])).length,
  ]));

  const firstValueRows = tenants.filter((row) => Boolean(row.first_value_at));
  const ttfv = firstValueRows
    .map((row) => durationMinutes(row.workspace_created_at || row.workspace_opened_at, row.first_value_at))
    .filter((value) => Number.isFinite(value));

  const sorted = [...ttfv].sort((a, b) => a - b);
  const median = sorted.length
    ? sorted[Math.floor((sorted.length - 1) / 2)]
    : null;

  return {
    tenants_observed: tenants.length,
    stages: stageCounts,
    first_value_reached: firstValueRows.length,
    returned_after_first_value: tenants.filter((row) => row.returned_after_first_value === true).length,
    time_to_first_value_minutes: {
      median,
      minimum: sorted.length ? sorted[0] : null,
      maximum: sorted.length ? sorted[sorted.length - 1] : null,
    },
  };
}

export function createOnboardingFunnelReportHandler({
  isAuthorized = authorized,
  store,
} = {}) {
  return async function onboardingFunnelReportHandler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed" });
    if (!isAuthorized(request)?.ok) return json(401, { error: "Unauthorized" });
    if (!store?.listFunnelRows) return json(503, { error: "Onboarding reporting is unavailable." });

    let rows;
    try {
      rows = await store.listFunnelRows();
    } catch {
      return json(503, { error: "Onboarding reporting is unavailable." });
    }

    const campaignGroups = new Map();
    for (const row of rows || []) {
      const key = String(row.campaign_code || "UNATTRIBUTED").trim().toUpperCase() || "UNATTRIBUTED";
      if (!campaignGroups.has(key)) campaignGroups.set(key, []);
      campaignGroups.get(key).push(row);
    }

    return json(200, {
      overall: summarize(rows),
      campaigns: [...campaignGroups.entries()].map(([campaign_code, campaignRows]) => ({
        campaign_code,
        source_channel: campaignRows.find((row) => row.source_channel)?.source_channel || null,
        campaign_name: campaignRows.find((row) => row.campaign_name)?.campaign_name || null,
        ...summarize(campaignRows),
      })).sort((a, b) =>
        b.first_value_reached - a.first_value_reached
        || b.tenants_observed - a.tenants_observed
        || a.campaign_code.localeCompare(b.campaign_code)),
      tenants: (rows || []).map((row) => ({
        business_id: row.business_id,
        campaign_code: row.campaign_code || null,
        source_channel: row.source_channel || null,
        campaign_name: row.campaign_name || null,
        current_plan_key: row.current_plan_key || null,
        subscription_status: row.subscription_status || null,
        workspace_created_at: iso(row.workspace_created_at),
        checkout_started_at: iso(row.checkout_started_at),
        checkout_completed_at: iso(row.checkout_completed_at),
        workspace_opened_at: iso(row.workspace_opened_at),
        square_connect_started_at: iso(row.square_connect_started_at),
        square_connected_at: iso(row.square_connected_at),
        business_pulse_loaded_at: iso(row.business_pulse_loaded_at),
        ai_workflow_used_at: iso(row.ai_workflow_used_at),
        first_value_at: iso(row.first_value_at),
        time_to_first_value_minutes: durationMinutes(
          row.workspace_created_at || row.workspace_opened_at,
          row.first_value_at,
        ),
        workspace_open_days: Number(row.workspace_open_days || 0),
        returned_after_first_value: row.returned_after_first_value === true,
      })),
      privacy_note: "Milestones only: no customer message text, product details, raw credentials, IP addresses, or browser fingerprints are stored.",
    });
  };
}

export default async function handler(request) {
  return createOnboardingFunnelReportHandler({
    store: createOnboardingAnalyticsStore(),
  })(request);
}
