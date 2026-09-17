import autoCityConfig from "../../clients/auto-city.json" with { type: "json" };
import dextersHatsConfig from "../../clients/dexters-hats.json" with { type: "json" };
import { createMasterPackage } from "../../core/publishing/master-package/create.mjs";
import { runShadowPublishing } from "../../core/publishing/orchestration/shadow.mjs";
import { summarizeShadowValue } from "../../core/publishing/metrics/shadow-value.mjs";
import { automotiveToMasterInput } from "../../verticals/automotive/publishing-adapter/index.mjs";
import { retailToMasterInput } from "../../verticals/retail/publishing-adapter/index.mjs";
import { saveShadowRun } from "./_publishing-store.mjs";

const CLIENTS = Object.freeze({
  "auto-city": Object.freeze({ vertical: "automotive", config: autoCityConfig, adapt: automotiveToMasterInput }),
  "dexters-hats": Object.freeze({ vertical: "retail", config: dextersHatsConfig, adapt: retailToMasterInput }),
});

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function configuredAdminKey() {
  return globalThis.Netlify?.env?.get("GROWTHWISE_ADMIN_KEY") ?? "";
}

export function createPublishingShadowHandler({ adminKey = configuredAdminKey, saveRun = saveShadowRun } = {}) {
  return async function publishingShadowHandler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed" });
    const expectedKey = adminKey();
    if (!expectedKey || request.headers.get("x-growthwise-key") !== expectedKey) {
      return json(401, { error: "Invalid GrowthWise access code." });
    }

    try {
      const startedAt = performance.now();
      const body = await request.json();
      const client = CLIENTS[body?.business_id];
      if (!client || body.vertical !== client.vertical) {
        return json(400, { error: "Unknown business or vertical" });
      }
      if (client.config.business_id !== body.business_id
        || client.config.publishing?.shadow_mode !== true
        || client.config.publishing?.live_actions_enabled !== false) {
        return json(400, { error: "Client is not configured for safe shadow publishing" });
      }
      if (!body.source_record || !Array.isArray(body.media) || !Array.isArray(body.channels)) {
        return json(400, { error: "source_record, media, and channels are required" });
      }

      const masterPackage = createMasterPackage(client.adapt({
        businessId: body.business_id,
        vehicle: client.vertical === "automotive" ? body.source_record : undefined,
        product: client.vertical === "retail" ? body.source_record : undefined,
        media: body.media,
        business: { name: client.config.display_name },
      }));
      const run = await runShadowPublishing({
        businessId: body.business_id,
        role: body.role,
        masterPackage,
        clientConfig: client.config,
        channelIds: body.channels,
      });
      const value_metrics = summarizeShadowValue(run, { preparationDurationMs: performance.now() - startedAt });
      const measuredRun = { ...run, value_metrics };
      await saveRun(measuredRun);
      return json(200, { ...measuredRun, live_actions_enabled: false });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError || /not allowed|not authorized|invalid/i.test(error.message)) {
        return json(400, { error: error.message });
      }
      return json(500, { error: "Shadow publishing failed" });
    }
  };
}

export default createPublishingShadowHandler();
