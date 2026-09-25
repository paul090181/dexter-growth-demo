import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildSquareBusinessPulse,
  clearWorkspaceCredentials,
  createOnboardingTracker,
  createTenantWorkspaceController,
  readWorkspaceCredentials,
  saveWorkspaceCredentials,
} from "../../assets/tenant-workspace.mjs";

const BUSINESS_ID = "north-star-books-abcdef123456";
const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

function storage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("workspace credentials stay in session storage only", () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  clearWorkspaceCredentials(s);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: "", tenantKey: "" });
});

test("business pulse turns Square summaries into useful metrics and actions", () => {
  const pulse = buildSquareBusinessPulse({
    summary: {
      item_count: 2,
      total_units_in_stock: 7,
      inventory_value: "525.00",
    },
    products: [
      { item_name: "Classic Hat", variation_name: "Black", track_inventory: true, quantity: 1 },
      { item_name: "Fedora", variation_name: "Brown", track_inventory: true, quantity: 6 },
    ],
  }, {
    summary: {
      completed_order_count: 4,
      total_collected: "360.00",
      average_order: "90.00",
    },
    top_products: [
      { item_name: "Classic Hat", total_collected: "200.00" },
    ],
  });

  assert.deepEqual(pulse.metrics, {
    sales: "$360.00",
    orders: 4,
    inventoryValue: "$525.00",
    units: 7,
  });
  assert.match(pulse.headline, /Classic Hat/);
  assert.match(pulse.primary, /top product/i);
  assert.equal(pulse.recommendations.some((item) => /2 units or fewer/i.test(item)), true);
  assert.equal(pulse.recommendations.some((item) => /Average completed order is \$90\.00/i.test(item)), true);
});

test("connected tenant loads only its own Square inventory and sales for the business pulse", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({ business_id: BUSINESS_ID, business_name: "North Star Books" });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: true },
        });
      }
      if (url.startsWith("/.netlify/functions/square-connection?")) {
        return response({
          business_id: BUSINESS_ID,
          state: "Connected",
          account: { display_name: "North Star Square" },
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-square-inventory?")) {
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          summary: { item_count: 1, total_units_in_stock: 3, inventory_value: "150.00" },
          products: [{ item_name: "Book", track_inventory: true, quantity: 3 }],
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-square-sales?")) {
        assert.match(url, /days=30/);
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          summary: { completed_order_count: 2, total_collected: "80.00", average_order: "40.00" },
          top_products: [{ item_name: "Book", total_collected: "80.00" }],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const state = await controller.restore();
  assert.equal(state.square.status.state, "Connected");
  assert.equal(state.insights.enabled, true);
  assert.equal(state.insights.pulse.metrics.sales, "$80.00");
  assert.equal(state.insights.pulse.metrics.inventoryValue, "$150.00");
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
  assert.equal(calls.filter((call) => call.url.includes(BUSINESS_ID)).length >= 5, true);
});

test("unconnected tenant never calls inventory or sales endpoints", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({ business_id: BUSINESS_ID, business_name: "North Star Books" });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: true },
        });
      }
      if (url.startsWith("/.netlify/functions/square-connection?")) {
        return response({ business_id: BUSINESS_ID, state: "Not Connected" });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const state = await controller.restore();
  assert.equal(state.insights.pulse, null);
  assert.equal(calls.some((call) => call.url.includes("tenant-square-inventory")), false);
  assert.equal(calls.some((call) => call.url.includes("tenant-square-sales")), false);
});

test("workspace milestone tracker keeps tenant keys out of URLs and dedupes within the session", async () => {
  const s = storage();
  const calls = [];
  const tracker = createOnboardingTracker({
    storage: s,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(url, "/.netlify/functions/onboarding-event");
      assert.equal(url.includes(TENANT_KEY), false);
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      assert.deepEqual(JSON.parse(init.body), {
        business_id: BUSINESS_ID,
        event_name: "workspace_opened",
      });
      return response({ ok: true, event_name: "workspace_opened", recorded: true });
    },
  });

  assert.equal(await tracker("workspace_opened", {
    businessId: BUSINESS_ID,
    tenantKey: TENANT_KEY,
  }), true);
  assert.equal(await tracker("workspace_opened", {
    businessId: BUSINESS_ID,
    tenantKey: TENANT_KEY,
  }), true);
  assert.equal(calls.length, 1);
});

test("analytics failures do not block the tenant workspace", async () => {
  const s = storage();
  const tracker = createOnboardingTracker({
    storage: s,
    fetchImpl: async () => response({ error: "analytics unavailable" }, 503),
  });
  assert.equal(await tracker("workspace_opened", {
    businessId: BUSINESS_ID,
    tenantKey: TENANT_KEY,
  }), false);
});

test("workspace sign-in validates tenant profile and subscription before persisting", async () => {
  const s = storage();
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          contact_name: "Jamie",
          contact_email: "jamie@example.com",
        });
      }
      return response({
        business_id: BUSINESS_ID,
        access_source: "stripe",
        plan_key: "founding_monthly",
        status: "active",
        access_granted: true,
      });
    },
  });

  const state = await controller.authenticate({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  assert.equal(state.signedIn, true);
  assert.equal(state.profile.business_name, "North Star Books");
  assert.equal(state.subscription.access_granted, true);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("failed sign-in clears attempted workspace credentials", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async () => response({ error: "Unauthorized" }, 401),
  });
  const state = await controller.authenticate({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY });
  assert.equal(state.signedIn, false);
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: "", tenantKey: "" });
});

test("billing management uses server-linked Stripe portal only", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let navigated = "";
  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => { navigated = url; },
    fetchImpl: async (url, init) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) return response({
        business_id: BUSINESS_ID, business_name: "North Star Books",
      });
      if (url.startsWith("/.netlify/functions/subscription-status?")) return response({
        business_id: BUSINESS_ID, access_source: "stripe", status: "active", access_granted: true,
      });
      assert.equal(url, "/.netlify/functions/stripe-customer-portal");
      assert.deepEqual(JSON.parse(init.body), { business_id: BUSINESS_ID });
      return response({ portal_url: "https://billing.stripe.com/p/session/test_123" });
    },
  });

  await controller.restore();
  assert.equal(await controller.openBilling(), true);
  assert.equal(navigated, "https://billing.stripe.com/p/session/test_123");
});





test("workspace opens a Stripe-hosted plan change confirmation without exposing price IDs", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let navigated = "";
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => { navigated = url; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) return response({
        business_id: BUSINESS_ID, business_name: "North Star Books",
      });
      if (url.startsWith("/.netlify/functions/subscription-status?")) return response({
        business_id: BUSINESS_ID,
        access_source: "stripe",
        plan_key: "growth_monthly",
        status: "active",
        access_granted: true,
      });
      assert.equal(url, "/.netlify/functions/stripe-plan-change");
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      assert.deepEqual(JSON.parse(init.body), {
        business_id: BUSINESS_ID,
        plan_key: "pro_monthly",
      });
      assert.doesNotMatch(init.body, /price_/);
      return response({
        portal_url: "https://billing.stripe.com/p/session/test_upgrade",
        target_plan_key: "pro_monthly",
      });
    },
  });

  await controller.restore();
  assert.equal(await controller.changePlan("pro_monthly"), true);
  assert.equal(navigated, "https://billing.stripe.com/p/session/test_upgrade");
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("inventory-enabled tenant reads only its own Square connection and starts OAuth with tenant auth", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  let navigated = "";

  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => { navigated = url; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });

      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
        });
      }

      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: true },
        });
      }

      if (url.startsWith("/.netlify/functions/square-connection?")) {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(url.includes(TENANT_KEY), false);
        return response({
          business_id: BUSINESS_ID,
          state: "Not Connected",
          account: null,
          action: "Connect Square.",
        });
      }

      assert.equal(url, "/.netlify/functions/square-oauth-start");
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
      assert.deepEqual(JSON.parse(init.body), { business_id: BUSINESS_ID });
      return response({
        authorization_url: "https://connect.squareupsandbox.com/oauth2/authorize?client_id=test&state=safe",
      });
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.square.enabled, true);
  assert.equal(restored.square.status.state, "Not Connected");

  assert.equal(await controller.connectSquare(), true);
  assert.equal(
    navigated,
    "https://connect.squareupsandbox.com/oauth2/authorize?client_id=test&state=safe",
  );
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("workspace does not call Square when inventory connection is not entitled", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let squareCalls = 0;

  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          plan_key: "starter_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: false },
        });
      }
      squareCalls += 1;
      return response({});
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.square.enabled, false);
  assert.equal(await controller.connectSquare(), false);
  assert.equal(squareCalls, 0);
});

test("workspace rejects a non-Square OAuth destination", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let navigated = "";

  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => { navigated = url; },
    fetchImpl: async (url) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: true },
        });
      }
      if (url.startsWith("/.netlify/functions/square-connection?")) {
        return response({
          business_id: BUSINESS_ID,
          state: "Not Connected",
        });
      }
      return response({
        authorization_url: "https://evil.example/oauth2/authorize",
      });
    },
  });

  await controller.restore();
  assert.equal(await controller.connectSquare(), false);
  assert.equal(navigated, "");
  assert.match(controller.getState().square.error, /invalid destination/i);
});


test("eligible tenant launches self-service customer channel setup without an admin invitation", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  let navigated = "";

  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => { navigated = url; },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({ business_id: BUSINESS_ID, business_name: "North Star Books" });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: false, unified_inbox: true },
        });
      }
      assert.equal(url, "/.netlify/functions/tenant-connector-session-start");
      assert.equal(init.credentials, "same-origin");
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
      assert.deepEqual(JSON.parse(init.body), { business_id: BUSINESS_ID });
      return response({
        ok: true,
        connection_url: "/connect-accounts.html",
        expires_at: "2026-09-25T23:00:00.000Z",
      });
    },
  });

  await controller.restore();
  assert.equal(await controller.openConnectorSetup(), true);
  assert.equal(navigated, "/connect-accounts.html");
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("Starter tenant cannot launch customer channel setup", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let connectorCalls = 0;

  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({ business_id: BUSINESS_ID, business_name: "North Star Books" });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: false, unified_inbox: false },
        });
      }
      connectorCalls += 1;
      return response({});
    },
  });

  await controller.restore();
  assert.equal(await controller.openConnectorSetup(), false);
  assert.equal(connectorCalls, 0);
});

test("active tenant can draft a lead reply with tenant auth and no admin key", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) return response({
        business_id: BUSINESS_ID, business_name: "North Star Books",
      });
      if (url.startsWith("/.netlify/functions/subscription-status?")) return response({
        business_id: BUSINESS_ID, access_source: "stripe", status: "active", access_granted: true,
      });
      assert.equal(url, `/.netlify/functions/retail-lead-assistant?business_id=${encodeURIComponent(BUSINESS_ID)}`);
      assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
      assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        source: "Email",
        customer_name: "Alex",
        message: "Do you have this in stock?",
        automation_mode: "shadow",
      });
      return response({
        ok: true,
        reply: "Which product are you asking about?",
        intent: "product_clarification",
        risk_level: "low",
        decision: "auto_reply",
        follow_up_action: "Identify the product.",
      });
    },
  });

  await controller.restore();
  assert.equal(await controller.draftLead({
    source: "Email",
    customerName: "Alex",
    message: "Do you have this in stock?",
  }), true);

  const state = controller.getState();
  assert.equal(state.lead.result.reply, "Which product are you asking about?");
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("locked tenant cannot call the lead assistant", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let leadCalls = 0;
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) return response({
        business_id: BUSINESS_ID, business_name: "North Star Books",
      });
      if (url.startsWith("/.netlify/functions/subscription-status?")) return response({
        business_id: BUSINESS_ID, access_source: "stripe", status: "past_due", access_granted: false,
      });
      leadCalls += 1;
      return response({});
    },
  });

  await controller.restore();
  assert.equal(await controller.draftLead({ source: "Email", message: "Hello" }), false);
  assert.equal(leadCalls, 0);
  assert.match(controller.getState().lead.error, /active workspace/i);
});

test("tenant workspace is generic and does not expose Dexter/admin credentials", () => {
  const html = fs.readFileSync(new URL("../../app.html", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../../assets/tenant-workspace.mjs", import.meta.url), "utf8");
  const headers = fs.readFileSync(new URL("../../_headers", import.meta.url), "utf8");

  assert.match(html, /Business workspace/);
  assert.match(html, /Workspace ID/);
  assert.match(html, /id="workspace-feature-grid"/);
  assert.match(html, /id="workspace-pro-trial"/);
  assert.match(html, /id="workspace-square-card"/);
  assert.match(html, /id="workspace-square-connect"/);
  assert.match(html, /id="workspace-onboarding-card"/);
  assert.match(html, /id="workspace-onboarding-list"/);
  assert.match(html, /id="workspace-journey-banner"/);
  assert.match(html, /id="workspace-next-step"/);
  assert.match(html, /id="workspace-channels-card"/);
  assert.match(html, /id="workspace-channels-open"/);
  assert.match(html, /id="workspace-pulse-card"/);
  assert.match(html, /id="workspace-pulse-sales"/);
  assert.match(html, /id="workspace-pulse-inventory-value"/);
  assert.match(html, /data-plan-change="starter_monthly"/);
  assert.match(html, /data-plan-change="growth_monthly"/);
  assert.match(html, /data-plan-change="pro_monthly"/);
  assert.match(js, /stripe-plan-change/);
  assert.match(js, /square-connection/);
  assert.match(js, /square-oauth-start/);
  assert.match(js, /tenant-square-inventory/);
  assert.match(js, /tenant-square-sales/);
  assert.match(js, /buildSquareBusinessPulse/);
  assert.match(js, /openActivation/);
  assert.match(js, /nextAction/);
  assert.match(js, /connect-square/);
  assert.match(js, /refresh-insights/);
  assert.match(js, /tenant-connector-session-start/);
  assert.match(js, /openConnectorSetup/);
  assert.match(js, /feature_access/);
  assert.match(js, /Pro Experience active/);
  assert.doesNotMatch(html + js, /dexters-hats|Dexter's Hats|Dexter|growthwise_admin_key|X-GrowthWise-Key/);
  assert.doesNotMatch(html + js, /localStorage/);
  assert.match(headers, /\/app\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});
