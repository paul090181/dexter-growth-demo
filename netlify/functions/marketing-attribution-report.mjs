import { authorized, json } from "./_lead-store.mjs";
import { PLAN_CATALOG } from "./_entitlements.mjs";
import { createMarketingAttributionStore } from "./_marketing-attribution-store.mjs";

const LIVE_STATUSES = new Set(["active", "trialing"]);

function clean(value, max = 160) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createMarketingAttributionReportHandler({
  isAuthorized = authorized,
  store,
} = {}) {
  return async function marketingAttributionReportHandler(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed" });
    if (!isAuthorized(request)?.ok) return json(401, { error: "Unauthorized" });
    if (!store?.listCampaignAcquisitions) return json(503, { error: "Attribution reporting is unavailable." });

    let rows;
    try {
      rows = await store.listCampaignAcquisitions();
    } catch {
      return json(503, { error: "Attribution reporting is unavailable." });
    }

    const campaigns = new Map();
    for (const row of rows || []) {
      const code = clean(row.campaign_code, 120).toUpperCase();
      if (!code) continue;
      if (!campaigns.has(code)) {
        campaigns.set(code, {
          campaign_code: code,
          source_channel: clean(row.source_channel, 120) || null,
          campaign_name: clean(row.campaign_name, 160) || null,
          acquired_tenants: 0,
          active_or_trialing: 0,
          plan_counts: { starter: 0, growth: 0, pro: 0, founding: 0, other: 0 },
          current_list_mrr_usd: 0,
          first_attributed_at: null,
          last_attributed_at: null,
        });
      }

      const campaign = campaigns.get(code);
      campaign.acquired_tenants += 1;

      const currentPlanKey = clean(row.current_plan_key, 120);
      const status = clean(row.subscription_status, 40);
      const active = row.access_source === "stripe" && LIVE_STATUSES.has(status);
      const plan = PLAN_CATALOG[currentPlanKey] || null;
      if (active) {
        campaign.active_or_trialing += 1;
        const bucket = plan?.tier && Object.hasOwn(campaign.plan_counts, plan.tier) ? plan.tier : "other";
        campaign.plan_counts[bucket] += 1;
        campaign.current_list_mrr_usd += Number(plan?.monthly_price_usd || 0);
      }

      const attributed = row.attributed_at ? new Date(row.attributed_at) : null;
      if (attributed && Number.isFinite(attributed.getTime())) {
        const iso = attributed.toISOString();
        if (!campaign.first_attributed_at || iso < campaign.first_attributed_at) campaign.first_attributed_at = iso;
        if (!campaign.last_attributed_at || iso > campaign.last_attributed_at) campaign.last_attributed_at = iso;
      }
    }

    return json(200, {
      campaigns: [...campaigns.values()].sort((a, b) =>
        b.active_or_trialing - a.active_or_trialing
        || b.acquired_tenants - a.acquired_tenants
        || a.campaign_code.localeCompare(b.campaign_code)),
      revenue_note: "MRR is current plan list price before promotion discounts, credits, taxes, refunds, or failed collections.",
    });
  };
}

export default async function handler(request) {
  return createMarketingAttributionReportHandler({
    store: createMarketingAttributionStore(),
  })(request);
}
