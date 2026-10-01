import assert from "node:assert/strict";
import test from "node:test";

import { createMarketingAttributionReportHandler } from "../../netlify/functions/marketing-attribution-report.mjs";

function request(key = "admin") {
  return new Request("https://preview.example/.netlify/functions/marketing-attribution-report", {
    headers: { "x-growthwise-key": key },
  });
}

test("campaign attribution report is admin-only", async () => {
  const handler = createMarketingAttributionReportHandler({
    isAuthorized: (req) => ({ ok: req.headers.get("x-growthwise-key") === "admin" }),
    store: { listCampaignAcquisitions: async () => [] },
  });
  assert.equal((await handler(request("wrong"))).status, 401);
});

test("campaign attribution report summarizes acquisition, plan mix, and list-price MRR", async () => {
  const handler = createMarketingAttributionReportHandler({
    isAuthorized: () => ({ ok: true }),
    store: {
      listCampaignAcquisitions: async () => [
        {
          business_id: "a",
          campaign_code: "STEVE20",
          source_channel: "podcast",
          campaign_name: "TESD",
          attributed_at: "2026-09-01T12:00:00.000Z",
          current_plan_key: "growth_monthly",
          subscription_status: "active",
          access_source: "stripe",
        },
        {
          business_id: "b",
          campaign_code: "STEVE20",
          source_channel: "podcast",
          campaign_name: "TESD",
          attributed_at: "2026-09-03T12:00:00.000Z",
          current_plan_key: "pro_monthly",
          subscription_status: "trialing",
          access_source: "stripe",
        },
        {
          business_id: "c",
          campaign_code: "STEVE20",
          source_channel: "podcast",
          campaign_name: "TESD",
          attributed_at: "2026-09-05T12:00:00.000Z",
          current_plan_key: "growth_monthly",
          subscription_status: "canceled",
          access_source: "stripe",
        },
        {
          business_id: "d",
          campaign_code: "WGR20",
          source_channel: "radio",
          campaign_name: "Sports radio test",
          attributed_at: "2026-09-04T12:00:00.000Z",
          current_plan_key: "starter_monthly",
          subscription_status: "active",
          access_source: "stripe",
        },
      ],
    },
  });

  const response = await handler(request());
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.campaigns.length, 2);
  const steve = body.campaigns.find((row) => row.campaign_code === "STEVE20");
  assert.equal(steve.acquired_tenants, 3);
  assert.equal(steve.active_or_trialing, 2);
  assert.equal(steve.plan_counts.growth, 1);
  assert.equal(steve.plan_counts.pro, 1);
  assert.equal(steve.current_list_mrr_usd, 598);
  assert.equal(steve.first_attributed_at, "2026-09-01T12:00:00.000Z");
  assert.equal(steve.last_attributed_at, "2026-09-05T12:00:00.000Z");

  const wgr = body.campaigns.find((row) => row.campaign_code === "WGR20");
  assert.equal(wgr.current_list_mrr_usd, 99);
  assert.match(body.revenue_note, /before promotion discounts/i);
});
