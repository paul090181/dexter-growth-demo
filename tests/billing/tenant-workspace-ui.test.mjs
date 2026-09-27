import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildOnboardingSteps,
  buildSquareBusinessPulse,
  businessStarterKit,
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
  assert.match(html, /id="workspace-starter-kit"/);
  assert.match(html, /What would help right now/);
  assert.match(html, /id="workspace-first-win-card"/);
  assert.match(html, /id="workspace-first-win-form"/);
  assert.match(html, /id="workspace-first-win-task"/);
  assert.match(html, /id="workspace-first-win-copy"/);
  assert.match(html, /id="workspace-first-win-copy-secondary"/);
  assert.match(html, /id="workspace-first-win-use-facebook"/);
  assert.match(html, /id="workspace-first-win-use-instagram"/);
  assert.match(html, /id="workspace-facebook-message"/);
  assert.match(html, /id="workspace-instagram-caption"/);
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
  assert.match(firstWinInstagramBridge, /instagramReviewed\.checked = false/);
  assert.doesNotMatch(firstWinInstagramBridge, /publishInstagram\(/);
  assert.match(js, /openConnectorSetup/);
  assert.match(js, /tenant-facebook-connection/);
  assert.match(js, /tenant-facebook-publish/);
  assert.match(js, /publishFacebook/);
  assert.match(js, /refreshFacebookStatus/);
  assert.match(js, /tenant-instagram-connection/);
  assert.match(js, /tenant-instagram-publish/);
  assert.match(js, /publishInstagram/);
  assert.match(js, /refreshInstagramStatus/);
  assert.match(js, /tenant-login-request/);
  assert.match(js, /tenant-session-logout/);
  assert.match(js, /You're signed in securely/);
  assert.match(js, /feature_access/);
  assert.match(js, /Pro Experience active/);
  assert.doesNotMatch(html + js, /dexters-hats|Dexter's Hats|Dexter|growthwise_admin_key|X-GrowthWise-Key/);
  assert.doesNotMatch(html + js, /localStorage/);
  assert.match(headers, /\/app\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});
