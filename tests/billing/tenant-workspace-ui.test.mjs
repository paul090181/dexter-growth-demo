import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildInboxPulse,
  buildOnboardingSteps,
  buildReplyLaunchUrl,
  buildSquareBusinessPulse,
  businessStarterKit,
  clearWorkspaceCredentials,
  createOnboardingTracker,
  createTenantWorkspaceController,
  filterInboxLeads,
  prioritizeInboxLeads,
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

test("Starter onboarding puts the first useful result before optional integrations", () => {
  assert.deepEqual(buildOnboardingSteps({
    accessGranted: true,
    firstWinReady: false,
    squareEligible: false,
  }), [
    ["Workspace ready", true, "Done"],
    ["Plan active", true, "Done"],
    ["First useful result", false, "Next"],
  ]);
});

test("Growth onboarding includes Square and Business Pulse only when entitled", () => {
  assert.deepEqual(buildOnboardingSteps({
    accessGranted: true,
    firstWinReady: true,
    squareEligible: true,
    squareConnected: true,
    pulseReady: false,
  }), [
    ["Workspace ready", true, "Done"],
    ["Plan active", true, "Done"],
    ["First useful result", true, "Done"],
    ["Square connected", true, "Done"],
    ["Business pulse ready", false, "Next"],
  ]);
});

test("Square can be deferred without blocking the rest of onboarding", () => {
  assert.deepEqual(buildOnboardingSteps({
    accessGranted: true,
    firstWinReady: true,
    squareEligible: true,
    squareConnected: false,
    squareSkipped: true,
    pulseReady: false,
  }), [
    ["Workspace ready", true, "Done"],
    ["Plan active", true, "Done"],
    ["First useful result", true, "Done"],
    ["Square connected", false, "Later"],
    ["Business pulse ready", false, "Later"],
  ]);
});

test("business starter kits adapt quick workflows by vertical without inventing business facts", () => {
  const bakery = businessStarterKit("bakery_food");
  assert.deepEqual(bakery.map((item) => item.kind), [
    "social_post",
    "customer_reply",
    "assistant",
  ]);
  assert.match(bakery[0].label, /seasonal treat/i);
  assert.match(bakery[1].label, /custom-order/i);

  const auto = businessStarterKit("auto_dealer");
  assert.match(auto[0].label, /vehicle/i);
  assert.match(auto[2].label, /lead follow-up/i);

  const service = businessStarterKit("service");
  assert.match(service[0].label, /openings/i);

  const fallback = businessStarterKit("unknown");
  assert.match(fallback[0].label, /promotion/i);

  bakery[0].label = "mutated";
  assert.notEqual(businessStarterKit("bakery_food")[0].label, "mutated");
});

test("unified inbox filters stay client-side and preserve original rows", () => {
  const leads = [
    { id: "ig-1", source_type: "instagram", unread: true, status: "new", created_at: "2026-09-27T14:00:00.000Z" },
    { id: "fb-1", source_type: "facebook", unread: false, status: "follow-up", created_at: "2026-09-27T15:00:00.000Z" },
    { id: "sms-1", source_type: "sms", unread: true, status: "closed", created_at: "2026-09-27T13:00:00.000Z" },
    { id: "phone-1", source_type: "phone", unread: false, status: "new", created_at: "2026-09-27T12:00:00.000Z" },
    { id: "manual-1", source_type: "manual", unread: false, status: "replied", created_at: "2026-09-27T11:00:00.000Z" },
    { id: "web-won", source_type: "website", unread: false, status: "won", created_at: "2026-09-27T10:00:00.000Z" },
  ];

  assert.deepEqual(filterInboxLeads(leads, "open").map((lead) => lead.id), ["fb-1", "ig-1", "phone-1"]);
  assert.deepEqual(filterInboxLeads(leads, "follow_up").map((lead) => lead.id), ["fb-1"]);
  assert.deepEqual(filterInboxLeads(leads, "won").map((lead) => lead.id), ["web-won"]);
  assert.deepEqual(filterInboxLeads(leads, "unread").map((lead) => lead.id), ["ig-1", "sms-1"]);
  assert.deepEqual(filterInboxLeads(leads, "instagram").map((lead) => lead.id), ["ig-1"]);
  assert.deepEqual(filterInboxLeads(leads, "sms_phone").map((lead) => lead.id), ["sms-1", "phone-1"]);
  assert.deepEqual(filterInboxLeads(leads, "other").map((lead) => lead.id), ["manual-1"]);
  assert.deepEqual(filterInboxLeads(leads, "unknown").map((lead) => lead.id), leads.map((lead) => lead.id));
  assert.equal(leads.length, 6);
});

test("unified inbox priority puts follow-up first, then unread, then older open leads", () => {
  const leads = [
    { id: "newer-read", unread: false, status: "new", created_at: "2026-09-27T15:00:00.000Z" },
    { id: "unread-new", unread: true, status: "new", created_at: "2026-09-27T16:00:00.000Z" },
    { id: "follow-newer", unread: false, status: "follow-up", created_at: "2026-09-27T14:00:00.000Z" },
    { id: "follow-older", unread: false, status: "follow-up", created_at: "2026-09-27T13:00:00.000Z" },
    { id: "replied", unread: false, status: "replied", created_at: "2026-09-27T12:00:00.000Z" },
  ];

  assert.deepEqual(prioritizeInboxLeads(leads).map((lead) => lead.id), [
    "follow-older",
    "follow-newer",
    "unread-new",
    "newer-read",
    "replied",
  ]);
  assert.deepEqual(leads.map((lead) => lead.id), [
    "newer-read",
    "unread-new",
    "follow-newer",
    "follow-older",
    "replied",
  ]);
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
  assert.equal(pulse.promotionSuggestion, null);
});

test("business pulse turns an in-stock top seller into a grounded Narleo promotion action", () => {
  const pulse = buildSquareBusinessPulse({
    summary: {
      item_count: 2,
      total_units_in_stock: 14,
      inventory_value: "900.00",
    },
    products: [
      { item_name: "Classic Hat", variation_name: "Black", track_inventory: true, quantity: 8 },
      { item_name: "Fedora", variation_name: "Brown", track_inventory: true, quantity: 6 },
    ],
  }, {
    summary: {
      completed_order_count: 7,
      total_collected: "720.00",
      average_order: "102.86",
    },
    top_products: [
      { item_name: "Classic Hat", total_collected: "420.00" },
    ],
  });

  assert.equal(pulse.promotionSuggestion.itemName, "Classic Hat");
  assert.match(pulse.promotionSuggestion.prompt, /top product by collected sales in the last 30 days/i);
  assert.match(pulse.promotionSuggestion.prompt, /do not invent price, stock, discount, materials, sizes, or availability/i);
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


test("passwordless tenant session restores the workspace without a JavaScript tenant key", async () => {
  const s = storage();
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === "/.netlify/functions/tenant-session") {
        assert.equal(init.credentials, "same-origin");
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          expires_at: "2026-10-26T01:30:00.000Z",
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], undefined);
        assert.equal(init.credentials, "same-origin");
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          contact_name: "Jamie",
          contact_email: "jamie@example.com",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], undefined);
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
          access_granted: true,
          feature_access: { inventory_connection: false, unified_inbox: false },
        });
      }
      if (url === "/.netlify/functions/onboarding-event") {
        return response({ ok: true, event_name: JSON.parse(init.body).event_name, recorded: true });
      }
      throw new Error(`unexpected URL ${url}`);
    },
    trackEvent: async () => true,
  });

  const state = await controller.restore();
  assert.equal(state.signedIn, true);
  assert.equal(state.profile.business_name, "North Star Books");
  assert.deepEqual(readWorkspaceCredentials(s), {
    businessId: BUSINESS_ID,
    tenantKey: "",
  });
  assert.equal(calls.some((call) => call.url.includes(TENANT_KEY)), false);
});

test("workspace requests a passwordless sign-in link without revealing account existence", async () => {
  const s = storage();
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      assert.equal(url, "/.netlify/functions/tenant-login-request");
      assert.equal(init.credentials, "same-origin");
      assert.deepEqual(JSON.parse(init.body), { email: "jamie@example.com" });
      return response({
        ok: true,
        message: "If that email belongs to a GrowthWise workspace, a secure sign-in link will arrive shortly.",
      });
    },
  });

  assert.equal(await controller.requestEmailSignIn("Jamie@Example.com"), true);
  assert.match(controller.getState().emailLogin.message, /If that email belongs/i);
  assert.equal(calls.length, 1);
});

test("sign out revokes the browser session and clears preview credentials", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === "/.netlify/functions/tenant-session-logout") {
        assert.equal(init.method, "POST");
        assert.equal(init.credentials, "same-origin");
        return response({ ok: true });
      }
      return response({ error: "unused" }, 500);
    },
  });

  await controller.signOut();
  assert.deepEqual(readWorkspaceCredentials(s), { businessId: "", tenantKey: "" });
  assert.equal(calls.length, 1);
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

test("inventory-enabled tenant can defer Square for the current onboarding session", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
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
          feature_access: {
            inventory_connection: true,
            unified_inbox: true,
            automated_publishing: false,
          },
        });
      }
      if (url.startsWith("/.netlify/functions/square-connection?")) {
        return response({
          business_id: BUSINESS_ID,
          state: "Not Connected",
          account: null,
          action: "Connect Square.",
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-inbox?")) {
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          count: 0,
          unread_count: 0,
          leads: [],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.square.skipped, false);
  const callCount = calls.length;
  assert.equal(controller.skipSquare(), true);
  assert.equal(controller.getState().square.skipped, true);
  assert.equal(s.getItem(`growthwise_square_skip:${BUSINESS_ID}`), "1");
  assert.equal(calls.length, callCount);
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
      if (url.startsWith("/.netlify/functions/tenant-inbox?")) {
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          count: 0,
          unread_count: 0,
          leads: [],
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

test("active tenant can get a first useful Narleo result before connecting any provider", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const tracked = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    trackEvent: async (eventName) => { tracked.push(eventName); return true; },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          business_type: "retail",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
          access_granted: true,
          feature_access: {
            inventory_connection: false,
            unified_inbox: false,
            automated_publishing: false,
            promotion_content: true,
            lead_reply_drafting: true,
          },
        });
      }
      if (url === "/.netlify/functions/tenant-first-win") {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
        assert.deepEqual(JSON.parse(init.body), {
          business_id: BUSINESS_ID,
          task: "social_post",
          prompt: "Feature a new mystery novel display.",
          image_data_url: "data:image/png;base64,AA==",
        });
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          business_type: "retail",
          task: "social_post",
          title: "Mystery shelf spotlight",
          primary_text: "A fresh mystery display is ready to browse.",
          secondary_text: "Mystery readers, take a look.",
          note: "Grounded in the supplied display context.",
          risk_level: "low",
          next_step: "Review and post when ready.",
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.firstWin.completed, false);
  assert.equal(await controller.createFirstWin({
    task: "social_post",
    prompt: "Feature a new mystery novel display.",
    imageDataUrl: "data:image/png;base64,AA==",
  }), true);
  const state = controller.getState();
  assert.equal(state.firstWin.completed, true);
  assert.equal(state.firstWin.result.title, "Mystery shelf spotlight");
  assert.equal(s.getItem(`growthwise_first_win:${BUSINESS_ID}`), "1");
  assert.equal(tracked.includes("first_win_created"), true);
  assert.equal(tracked.includes("ai_workflow_used"), true);
  assert.equal(await controller.rateFirstWin("helpful"), true);
  assert.equal(controller.getState().firstWin.feedback, "helpful");
  assert.equal(s.getItem(`growthwise_first_win_feedback:${BUSINESS_ID}`), "helpful");
  assert.equal(tracked.includes("first_win_helpful"), true);
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("active tenant can ask Narleo from inside the workspace without an admin key", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const tracked = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    trackEvent: async (eventName) => { tracked.push(eventName); return true; },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          business_type: "retail",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "starter_monthly",
          status: "active",
          access_granted: true,
          feature_access: {
            inventory_connection: false,
            unified_inbox: false,
            automated_publishing: false,
            ai_business_assistant: true,
          },
        });
      }
      if (url === "/.netlify/functions/tenant-business-assistant") {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
        assert.deepEqual(JSON.parse(init.body), {
          business_id: BUSINESS_ID,
          question: "What should I promote this week?",
          history: [],
        });
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          business_type: "retail",
          answer: "Feature one strong category with a clear reason to visit.",
          recommended_action: "Pick one display and build a focused post around it.",
          context_status: "needs_more_business_data",
          data_needed: ["Recent category sales"],
          suggested_follow_ups: ["Which category should I choose?"],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await controller.restore();
  assert.equal(await controller.askNarleo("What should I promote this week?"), true);
  const state = controller.getState();
  assert.equal(state.assistant.messages.length, 2);
  assert.equal(state.assistant.messages[0].role, "user");
  assert.equal(state.assistant.messages[1].role, "assistant");
  assert.equal(state.assistant.result.data_needed[0], "Recent category sales");
  assert.equal(tracked.includes("ai_workflow_used"), true);
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("locked tenant cannot call Narleo business assistant", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let assistantCalls = 0;
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
          status: "past_due",
          access_granted: false,
          feature_access: { ai_business_assistant: false },
        });
      }
      assistantCalls += 1;
      return response({});
    },
  });

  await controller.restore();
  assert.equal(await controller.askNarleo("Help me"), false);
  assert.equal(assistantCalls, 0);
});

test("unified-inbox tenant loads recent messages and refreshes without exposing admin credentials", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  let inboxReads = 0;
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          business_type: "retail",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: {
            inventory_connection: false,
            unified_inbox: true,
            automated_publishing: false,
            lead_reply_drafting: true,
          },
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-inbox?")) {
        inboxReads += 1;
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(url.includes(TENANT_KEY), false);
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          count: 2,
          unread_count: 1,
          leads: [{
            id: "ig-1",
            source: "Instagram",
            source_type: "instagram",
            customer_name: "Alex",
            customer_contact: "@alex",
            message: "Do you have this in another size?",
            direction: "inbound",
            unread: true,
            reply_supported: true,
            status: "new",
          }, {
            id: "email-1",
            source: "Email",
            source_type: "email",
            customer_name: null,
            customer_contact: "customer@example.com",
            message: "Are you open Sunday?",
            direction: "inbound",
            unread: false,
            reply_supported: false,
            status: "follow-up",
          }],
        });
      }
      if (url === "/.netlify/functions/tenant-inbox-action") {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
        const body = JSON.parse(init.body);
        assert.equal(body.business_id, BUSINESS_ID);
        assert.equal(body.lead_id, "ig-1");
        const statusByAction = {
          mark_read: "new",
          needs_follow_up: "follow-up",
          mark_won: "won",
          close: "closed",
          reopen: "new",
        };
        assert.equal(Object.hasOwn(statusByAction, body.action), true);
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          lead_id: "ig-1",
          unread: false,
          status: statusByAction[body.action],
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.inbox.enabled, true);
  assert.equal(restored.inbox.count, 2);
  assert.equal(restored.inbox.unreadCount, 1);
  assert.equal(restored.inbox.leads[0].source_type, "instagram");
  assert.equal(await controller.refreshInbox(), true);
  assert.equal(inboxReads, 2);
  assert.equal(await controller.markInboxRead("ig-1"), true);
  assert.equal(controller.getState().inbox.unreadCount, 0);
  assert.equal(controller.getState().inbox.leads[0].unread, false);
  assert.equal(await controller.updateInboxStatus("ig-1", "needs_follow_up"), true);
  assert.equal(controller.getState().inbox.leads[0].status, "follow-up");
  assert.equal(await controller.updateInboxStatus("ig-1", "mark_won"), true);
  assert.equal(controller.getState().inbox.leads[0].status, "won");
  assert.equal(await controller.updateInboxStatus("ig-1", "reopen"), true);
  assert.equal(controller.getState().inbox.leads[0].status, "new");
  assert.equal(await controller.updateInboxStatus("ig-1", "close"), true);
  assert.equal(controller.getState().inbox.leads[0].status, "closed");
  assert.equal(await controller.updateInboxStatus("ig-1", "reopen"), true);
  assert.equal(controller.getState().inbox.leads[0].status, "new");
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
  assert.equal(calls.every((call) => !Object.hasOwn(call.init?.headers || {}, "X-GrowthWise-Key")), true);
});

test("publishing-enabled tenant loads only its own social accounts and publishes only after review", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const calls = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
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
          feature_access: {
            inventory_connection: false,
            unified_inbox: true,
            automated_publishing: true,
          },
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-inbox?")) {
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          count: 0,
          unread_count: 0,
          leads: [],
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-facebook-connection?")) {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(url.includes(TENANT_KEY), false);
        return response({
          business_id: BUSINESS_ID,
          state: "Connected",
          account: { page_name: "North Star Books" },
          action: "",
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-instagram-connection?")) {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(url.includes(TENANT_KEY), false);
        return response({
          business_id: BUSINESS_ID,
          state: "Connected",
          account: { username: "northstarbooks", name: "North Star Books" },
          action: "",
        });
      }
      if (url === "/.netlify/functions/tenant-facebook-publish") {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
        assert.deepEqual(JSON.parse(init.body), {
          business_id: BUSINESS_ID,
          reviewed: true,
          message: "New arrivals are here.",
          expected_page_name: "North Star Books",
          image_data_url: "data:image/jpeg;base64,AA==",
        });
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          page_name: "North Star Books",
          post_type: "photo",
          post_id: "page-123_456",
          photo_count: 1,
        });
      }
      if (url === "/.netlify/functions/tenant-instagram-publish") {
        assert.equal(init.headers["X-GrowthWise-Tenant-Key"], TENANT_KEY);
        assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
        assert.deepEqual(JSON.parse(init.body), {
          business_id: BUSINESS_ID,
          reviewed: true,
          caption: "Mystery readers, take a look.",
          image_data_url: "data:image/jpeg;base64,AA==",
        });
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          published: true,
          live_sent: true,
          media_id: "ig-media-123",
          account: { username: "northstarbooks" },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.facebook.enabled, true);
  assert.equal(restored.facebook.status.state, "Connected");
  assert.equal(restored.facebook.status.account.page_name, "North Star Books");
  assert.equal(restored.instagram.enabled, true);
  assert.equal(restored.instagram.status.state, "Connected");
  assert.equal(restored.instagram.status.account.username, "northstarbooks");

  assert.equal(await controller.publishFacebook({
    message: "New arrivals are here.",
    imageDataUrl: "data:image/jpeg;base64,AA==",
    reviewed: false,
  }), false);
  assert.match(controller.getState().facebook.publishError, /confirm/i);
  assert.equal(calls.some((call) => call.url === "/.netlify/functions/tenant-facebook-publish"), false);

  assert.equal(await controller.publishFacebook({
    message: "New arrivals are here.",
    imageDataUrl: "data:image/jpeg;base64,AA==",
    reviewed: true,
  }), true);
  assert.equal(controller.getState().facebook.result.page_name, "North Star Books");

  assert.equal(await controller.publishInstagram({
    caption: "Mystery readers, take a look.",
    imageDataUrl: "data:image/jpeg;base64,AA==",
    reviewed: false,
  }), false);
  assert.match(controller.getState().instagram.publishError, /confirm/i);
  assert.equal(calls.some((call) => call.url === "/.netlify/functions/tenant-instagram-publish"), false);

  assert.equal(await controller.publishInstagram({
    caption: "Mystery readers, take a look.",
    imageDataUrl: "data:image/jpeg;base64,AA==",
    reviewed: true,
  }), true);
  assert.equal(controller.getState().instagram.result.account.username, "northstarbooks");
  assert.equal(calls.every((call) => !call.url.includes(TENANT_KEY)), true);
});

test("workspace never checks Facebook publishing for a plan without that entitlement", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  let facebookCalls = 0;
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
          feature_access: {
            inventory_connection: false,
            unified_inbox: false,
            automated_publishing: false,
          },
        });
      }
      facebookCalls += 1;
      return response({});
    },
  });

  const restored = await controller.restore();
  assert.equal(restored.facebook.enabled, false);
  assert.equal(await controller.refreshFacebookStatus(), false);
  assert.equal(await controller.publishFacebook({ message: "No", reviewed: true }), false);
  assert.equal(facebookCalls, 0);
});

test("inbox pulse summarizes recent workload without inventing conversion metrics", () => {
  const pulse = buildInboxPulse([
    { source_type: "website", status: "new", unread: true },
    { source_type: "website", status: "follow-up", unread: false },
    { source_type: "instagram", status: "replied", unread: false },
    { source_type: "facebook", status: "closed", unread: false },
    { source_type: "instagram", status: "new", unread: true },
    { source_type: "website", status: "won", unread: false },
  ]);

  assert.deepEqual(pulse, {
    total: 6,
    open: 3,
    followUp: 1,
    unread: 2,
    replied: 1,
    won: 1,
    closed: 1,
    sources: [
      { source: "website", count: 3 },
      { source: "instagram", count: 2 },
      { source: "facebook", count: 1 },
    ],
  });
  assert.equal(Object.hasOwn(pulse, "conversion_rate"), false);
  assert.equal(Object.hasOwn(pulse, "lead_quality"), false);
});

test("reply launcher only builds explicit email or SMS composers and never sends automatically", () => {
  assert.equal(buildReplyLaunchUrl({
    sourceType: "website",
    replyTarget: "customer@example.com",
    replyText: "Thanks — we will confirm availability.",
  }), "mailto:customer%40example.com?body=Thanks%20%E2%80%94%20we%20will%20confirm%20availability.");

  assert.equal(buildReplyLaunchUrl({
    sourceType: "website",
    replyTarget: "(716) 555-0100",
    replyText: "Thanks!",
  }), "sms:7165550100?body=Thanks!");

  assert.equal(buildReplyLaunchUrl({
    sourceType: "instagram",
    replyTarget: "javascript:alert(1)",
    replyText: "No",
  }), "");
  assert.equal(buildReplyLaunchUrl({
    sourceType: "email",
    replyTarget: "not-an-email",
    replyText: "No",
  }), "");
  assert.equal(buildReplyLaunchUrl({
    sourceType: "email",
    replyTarget: "customer@example.com",
    replyText: "",
  }), "");
});

test("owner can hand a drafted website reply to the native email composer without Narleo sending it", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const navigations = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    navigate: (url) => navigations.push(url),
    fetchImpl: async (url, init = {}) => {
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
        });
      }
      if (url.startsWith("/.netlify/functions/retail-lead-assistant?")) {
        assert.equal(Object.hasOwn(init.headers, "X-GrowthWise-Key"), false);
        return response({
          ok: true,
          reply: "Thanks for reaching out. We can help with that request.",
          intent: "general_inquiry",
          risk_level: "low",
          decision: "review",
          follow_up_action: "Review and send.",
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await controller.restore();
  assert.equal(await controller.draftLead({
    source: "Website form",
    sourceType: "website",
    replyTarget: "customer@example.com",
    customerName: "Alex",
    message: "Can I place an order for Saturday?",
    sourceLeadId: "web-1",
  }), true);

  assert.equal(controller.openDraftReplyComposer(), true);
  assert.equal(navigations.length, 1);
  assert.match(navigations[0], /^mailto:customer%40example\.com\?body=/);
  assert.match(decodeURIComponent(navigations[0]), /Thanks for reaching out/);
  assert.equal(controller.getState().lead.markedReplied, false);
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

test("inbox-originated Narleo draft is marked replied only after explicit owner confirmation", async () => {
  const s = storage();
  saveWorkspaceCredentials({ businessId: BUSINESS_ID, tenantKey: TENANT_KEY }, s);
  const actions = [];
  const controller = createTenantWorkspaceController({
    storage: s,
    fetchImpl: async (url, init = {}) => {
      if (url.startsWith("/.netlify/functions/tenant-profile?")) {
        return response({
          business_id: BUSINESS_ID,
          business_name: "North Star Books",
          business_type: "retail",
        });
      }
      if (url.startsWith("/.netlify/functions/subscription-status?")) {
        return response({
          business_id: BUSINESS_ID,
          access_source: "stripe",
          plan_key: "growth_monthly",
          status: "active",
          access_granted: true,
          feature_access: {
            unified_inbox: true,
            lead_reply_drafting: true,
            automated_publishing: false,
            inventory_connection: false,
          },
        });
      }
      if (url.startsWith("/.netlify/functions/tenant-inbox?")) {
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          count: 1,
          unread_count: 1,
          leads: [{
            id: "ig-1",
            source: "Instagram",
            source_type: "instagram",
            customer_name: "Alex",
            message: "Do you have this in another size?",
            direction: "inbound",
            unread: true,
            status: "new",
          }],
        });
      }
      if (url.startsWith("/.netlify/functions/retail-lead-assistant?")) {
        const body = JSON.parse(init.body);
        assert.equal(body.message, "Do you have this in another size?");
        return response({
          ok: true,
          reply: "Which size are you looking for?",
          intent: "product_clarification",
          risk_level: "low",
          decision: "auto_reply",
          follow_up_action: "Confirm the requested size.",
        });
      }
      if (url === "/.netlify/functions/tenant-inbox-action") {
        const body = JSON.parse(init.body);
        actions.push(body);
        return response({
          ok: true,
          business_id: BUSINESS_ID,
          lead_id: body.lead_id,
          unread: false,
          status: body.action === "mark_replied" ? "replied" : "new",
        });
      }
      throw new Error(`unexpected URL ${url}`);
    },
  });

  await controller.restore();
  assert.equal(await controller.draftLead({
    source: "Instagram",
    customerName: "Alex",
    message: "Do you have this in another size?",
    sourceLeadId: "ig-1",
  }), true);
  assert.equal(controller.getState().lead.sourceLeadId, "ig-1");
  assert.equal(controller.getState().lead.markedReplied, false);
  assert.equal(actions.length, 0);

  assert.equal(await controller.markDraftReplied(), true);
  assert.equal(controller.getState().lead.markedReplied, true);
  assert.equal(controller.getState().inbox.leads[0].status, "replied");
  assert.deepEqual(actions, [{
    business_id: BUSINESS_ID,
    lead_id: "ig-1",
    action: "mark_replied",
  }]);
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
  assert.match(html, /id="workspace-email-signin-form"/);
  assert.match(html, /Email me a sign-in link/);
  assert.match(html, /id="workspace-feature-grid"/);
  assert.match(html, /id="workspace-pro-trial"/);
  assert.match(html, /id="workspace-square-card"/);
  assert.match(html, /id="workspace-square-connect"/);
  assert.match(html, /id="workspace-square-skip"/);
  assert.match(html, /id="workspace-onboarding-card"/);
  assert.match(html, /id="workspace-onboarding-list"/);
  assert.match(html, /id="workspace-journey-banner"/);
  assert.match(html, /id="workspace-next-step"/);
  assert.match(html, /id="workspace-channels-card"/);
  assert.match(html, /id="workspace-channels-open"/);
  assert.match(html, /id="workspace-inbox-card"/);
  assert.match(html, /id="workspace-inbox-refresh"/);
  assert.match(html, /id="workspace-inbox-pulse"/);
  assert.match(html, /id="workspace-inbox-open-count"/);
  assert.match(html, /id="workspace-inbox-follow-count"/);
  assert.match(html, /id="workspace-inbox-unread-count"/);
  assert.match(html, /id="workspace-inbox-replied-count"/);
  assert.match(html, /id="workspace-inbox-won-count"/);
  assert.match(html, /id="workspace-inbox-source-summary"/);
  assert.match(html, /id="workspace-inbox-ask"/);
  assert.match(html, /id="workspace-inbox-filter"/);
  assert.match(html, /id="workspace-inbox-attention"/);
  assert.match(html, /id="workspace-inbox-attention-title"/);
  assert.match(html, /id="workspace-inbox-attention-detail"/);
  assert.match(html, /id="workspace-inbox-next"/);
  assert.match(html, /Work next lead/);
  assert.match(html, /value="won"/);
  assert.match(html, /value="unread"/);
  assert.match(html, /value="sms_phone"/);
  assert.match(html, /id="workspace-inbox-list"/);
  assert.match(html, /id="workspace-lead-source"/);
  assert.match(html, /id="workspace-lead-customer"/);
  assert.match(html, /id="workspace-lead-message"/);
  assert.match(html, /id="workspace-lead-copy"/);
  assert.match(html, /id="workspace-lead-mark-replied"/);
  assert.match(html, /Mark as replied/);
  assert.match(html, /id="workspace-lead-copy-status"/);
  assert.match(html, /<option>Phone<\/option>/);
  assert.match(html, /id="workspace-starter-kit"/);
  assert.match(html, /What would help right now/);
  assert.match(html, /id="workspace-first-win-card"/);
  assert.match(html, /id="workspace-first-win-form"/);
  assert.match(html, /id="workspace-first-win-task"/);
  assert.match(html, /id="workspace-first-win-copy"/);
  assert.match(html, /id="workspace-first-win-copy-secondary"/);
  assert.match(html, /id="workspace-first-win-use-facebook"/);
  assert.match(html, /id="workspace-first-win-use-instagram"/);
  assert.match(html, /id="workspace-first-win-feedback"/);
  assert.match(html, /id="workspace-first-win-helpful"/);
  assert.match(html, /id="workspace-first-win-needs-improvement"/);
  assert.match(html, /id="workspace-first-win-feedback-status"/);
  assert.match(html, /id="workspace-facebook-message"/);
  assert.match(html, /id="workspace-instagram-caption"/);
  assert.match(html, /id="workspace-instagram-image"[^>]*accept="image\/jpeg"/);
  assert.match(html, /id="workspace-assistant-card"/);
  assert.match(html, /id="workspace-assistant-form"/);
  assert.match(html, /id="workspace-assistant-thread"/);
  assert.match(html, /Ask Narleo/);
  assert.match(html, /Create my first result/);
  assert.match(html, /id="workspace-facebook-card"/);
  assert.match(html, /id="workspace-facebook-form"/);
  assert.match(html, /id="workspace-facebook-reviewed"/);
  assert.match(html, /id="workspace-facebook-publish"/);
  assert.match(html, /id="workspace-instagram-card"/);
  assert.match(html, /id="workspace-instagram-form"/);
  assert.match(html, /id="workspace-instagram-reviewed"/);
  assert.match(html, /id="workspace-instagram-publish"/);
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
  assert.match(js, /promotionSuggestion/);
  assert.match(js, /pulsePromote\.dataset\.prompt/);
  assert.match(js, /pulseAsk\.dataset\.prompt/);
  assert.match(js, /current Square Business Pulse says/);
  assert.match(js, /Create a post for/);
  const pulseAskStart = js.indexOf("pulseAsk?.addEventListener");
  const pulseAskEnd = js.indexOf("squareConnect?.addEventListener", pulseAskStart);
  assert.equal(pulseAskStart >= 0 && pulseAskEnd > pulseAskStart, true);
  const pulseAskBridge = js.slice(pulseAskStart, pulseAskEnd);
  assert.match(pulseAskBridge, /assistantQuestion\.value = prompt/);
  assert.doesNotMatch(pulseAskBridge, /askNarleo\(/);
  assert.match(js, /openActivation/);
  assert.match(js, /nextAction/);
  assert.match(js, /connect-square/);
  assert.match(js, /growthwise_square_skip/);
  assert.match(js, /skipSquare/);
  assert.match(js, /refresh-insights/);
  assert.match(js, /tenant-connector-session-start/);
  assert.match(js, /tenant-first-win/);
  assert.match(js, /tenant-business-assistant/);
  assert.match(js, /askNarleo/);
  assert.match(js, /businessStarterKit/);
  assert.match(js, /data-starter-kind|starterKind/);
  assert.match(js, /createFirstWin/);
  assert.match(js, /rateFirstWin/);
  assert.match(js, /first_win_helpful/);
  assert.match(js, /first_win_needs_improvement/);
  assert.match(js, /growthwise_first_win_feedback/);
  assert.match(js, /growthwise_first_win/);
  assert.match(js, /facebookMessage\.value = result\.primary_text/);
  assert.match(js, /facebookReviewed\.checked = false/);
  const firstWinFacebookStart = js.indexOf("firstWinUseFacebook?.addEventListener");
  const firstWinFacebookEnd = js.indexOf("firstWinForm?.addEventListener", firstWinFacebookStart);
  assert.equal(firstWinFacebookStart >= 0 && firstWinFacebookEnd > firstWinFacebookStart, true);
  const firstWinFacebookBridge = js.slice(firstWinFacebookStart, firstWinFacebookEnd);
  assert.doesNotMatch(firstWinFacebookBridge, /publishFacebook\(/);
  const firstWinInstagramStart = js.indexOf("firstWinUseInstagram?.addEventListener");
  const firstWinInstagramEnd = js.indexOf("firstWinForm?.addEventListener", firstWinInstagramStart);
  assert.equal(firstWinInstagramStart >= 0 && firstWinInstagramEnd > firstWinInstagramStart, true);
  const firstWinInstagramBridge = js.slice(firstWinInstagramStart, firstWinInstagramEnd);
  assert.match(firstWinInstagramBridge, /instagramCaption\.value = result\.secondary_text/);
  assert.match(firstWinInstagramBridge, /data:image\/jpeg;base64/);
  assert.match(firstWinInstagramBridge, /instagramReviewed\.checked = false/);
  assert.doesNotMatch(firstWinInstagramBridge, /publishInstagram\(/);
  assert.match(js, /openConnectorSetup/);
  assert.match(js, /tenant-inbox/);
  assert.match(js, /tenant-inbox-action/);
  assert.match(js, /refreshInbox/);
  assert.match(js, /prioritizeInboxLeads/);
  assert.match(js, /leads need attention/);
  assert.match(js, /inboxNext/);
  assert.match(js, /filterInboxLeads/);
  assert.match(js, /buildInboxPulse/);
  assert.match(js, /const inboxPulse = documentImpl\.getElementById\("workspace-inbox-pulse"\)/);
  assert.match(js, /const inboxOpenCount = documentImpl\.getElementById\("workspace-inbox-open-count"\)/);
  assert.match(js, /const inboxFollowCount = documentImpl\.getElementById\("workspace-inbox-follow-count"\)/);
  assert.match(js, /const inboxUnreadCount = documentImpl\.getElementById\("workspace-inbox-unread-count"\)/);
  assert.match(js, /const inboxRepliedCount = documentImpl\.getElementById\("workspace-inbox-replied-count"\)/);
  assert.match(js, /const inboxWonCount = documentImpl\.getElementById\("workspace-inbox-won-count"\)/);
  assert.match(js, /const inboxSourceSummary = documentImpl\.getElementById\("workspace-inbox-source-summary"\)/);
  assert.match(js, /const inboxAsk = documentImpl\.getElementById\("workspace-inbox-ask"\)/);
  assert.match(js, /const leads = Array\.isArray\(view\.inbox\?\.leads\)[\s\S]*const sourceLabels = \{/);
  assert.equal((js.match(/const sourceLabels = \{/g) || []).length, 1);
  assert.match(js, /Recent sources/);
  assert.match(js, /Based only on these counts/);
  assert.match(js, /Do not assume lead quality, revenue, profit, conversion rate, sales value, or customer intent/);
  assert.match(js, /No messages match this filter/);
  assert.match(js, /markInboxRead/);
  assert.match(js, /updateInboxStatus/);
  assert.match(js, /markDraftReplied/);
  assert.match(js, /sourceLeadId/);
  assert.match(js, /buildReplyLaunchUrl/);
  assert.match(js, /openDraftReplyComposer/);
  assert.match(js, /replyTarget/);
  assert.match(js, /sourceType/);
  assert.match(js, /mark_replied/);
  assert.match(js, /mark_won/);
  assert.match(js, /Needs follow-up/);
  assert.match(js, /Reopen/);
  assert.match(js, /Done/);
  assert.match(js, /Mark read/);
  assert.match(js, /Draft reply with Narleo/);
  const inboxDraftStart = js.indexOf('draft.textContent = "Draft reply with Narleo"');
  const inboxDraftEnd = js.indexOf("actions.append(draft)", inboxDraftStart);
  assert.equal(inboxDraftStart >= 0 && inboxDraftEnd > inboxDraftStart, true);
  const inboxDraftBridge = js.slice(inboxDraftStart, inboxDraftEnd);
  assert.match(inboxDraftBridge, /controller\.draftLead\(/);
  assert.match(inboxDraftBridge, /sourceLeadId:\s*lead\.id/);
  assert.match(inboxDraftBridge, /controller\.markInboxRead\(lead\.id\)/);
  assert.doesNotMatch(inboxDraftBridge, /send|publish/i);
  assert.match(html, /Copy suggested reply/);
  assert.match(html, /id="workspace-lead-open-reply"/);
  assert.match(js, /navigator\?\.clipboard\?\.writeText/);
  assert.match(js, /phone: "Phone"/);
  assert.match(js, /tenant-facebook-connection/);
  assert.match(js, /tenant-facebook-publish/);
  assert.match(js, /publishFacebook/);
  assert.match(js, /refreshFacebookStatus/);
  assert.match(js, /tenant-instagram-connection/);
  assert.match(js, /tenant-instagram-publish/);
  assert.match(js, /publishInstagram/);
  assert.match(js, /refreshInstagramStatus/);
  assert.match(js, /tenant-login-request/);
  assert.match(html, /id="workspace-preview-support"[^>]*hidden/);
  assert.match(js, /deploy-preview-\\d\+--euphonious-beijinho-db4b4d\\\.netlify\\\.app/);
  assert.match(js, /previewSupport\.hidden\s*=\s*!/);
  assert.match(js, /tenant-session-logout/);
  assert.match(js, /You're signed in securely/);
  assert.match(js, /feature_access/);
  assert.match(js, /Pro Experience active/);
  assert.doesNotMatch(html + js, /dexters-hats|Dexter's Hats|Dexter|growthwise_admin_key|X-GrowthWise-Key/);
  assert.doesNotMatch(html + js, /localStorage/);
  assert.match(headers, /\/app\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});
