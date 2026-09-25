const PROFILE_ENDPOINT = "/.netlify/functions/tenant-profile";
const STATUS_ENDPOINT = "/.netlify/functions/subscription-status";
const PORTAL_ENDPOINT = "/.netlify/functions/stripe-customer-portal";
const PLAN_CHANGE_ENDPOINT = "/.netlify/functions/stripe-plan-change";
const LEAD_ENDPOINT = "/.netlify/functions/retail-lead-assistant";
const SQUARE_CONNECTION_ENDPOINT = "/.netlify/functions/square-connection";
const SQUARE_OAUTH_START_ENDPOINT = "/.netlify/functions/square-oauth-start";
const SQUARE_INVENTORY_ENDPOINT = "/.netlify/functions/tenant-square-inventory";
const SQUARE_SALES_ENDPOINT = "/.netlify/functions/tenant-square-sales";
const ONBOARDING_EVENT_ENDPOINT = "/.netlify/functions/onboarding-event";

const FEATURE_LABELS = Object.freeze([
  ["ai_business_assistant", "AI business assistant"],
  ["lead_reply_drafting", "AI lead reply"],
  ["promotion_content", "Promotions & content"],
  ["inventory_connection", "Inventory connection"],
  ["unified_inbox", "Unified inbox"],
  ["automated_publishing", "Automated publishing"],
  ["orders_restock", "Orders & restock"],
  ["business_insights", "Business insights"],
  ["multi_channel_automation", "Multi-channel automation"],
  ["advanced_ai_automation", "Advanced AI automation"],
  ["multi_location", "Multiple locations"],
]);

export function readWorkspaceCredentials(storage = globalThis.sessionStorage) {
  return {
    businessId: storage?.getItem("growthwise_business_id") || "",
    tenantKey: storage?.getItem("growthwise_tenant_key") || "",
  };
}

export function saveWorkspaceCredentials({ businessId, tenantKey }, storage = globalThis.sessionStorage) {
  storage?.setItem("growthwise_business_id", businessId);
  storage?.setItem("growthwise_tenant_key", tenantKey);
}

export function clearWorkspaceCredentials(storage = globalThis.sessionStorage) {
  storage?.removeItem("growthwise_business_id");
  storage?.removeItem("growthwise_tenant_key");
}

function authHeaders(tenantKey) {
  return { "X-GrowthWise-Tenant-Key": tenantKey };
}

export function createOnboardingTracker({
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
} = {}) {
  return async function trackOnboardingEvent(eventName, { businessId, tenantKey } = {}) {
    const name = String(eventName || "").trim();
    const id = String(businessId || "").trim();
    const key = String(tenantKey || "").trim();
    if (!name || !id || !key) return false;

    const dedupeKey = `growthwise_onboarding_event:${id}:${name}`;
    if (storage?.getItem(dedupeKey) === "1") return true;

    try {
      const response = await fetchImpl(ONBOARDING_EVENT_ENDPOINT, {
        method: "POST",
        headers: {
          ...authHeaders(key),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          business_id: id,
          event_name: name,
        }),
        cache: "no-store",
        keepalive: true,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || body?.event_name !== name) return false;
      storage?.setItem(dedupeKey, "1");
      return true;
    } catch {
      return false;
    }
  };
}

function money(value) {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount)
    : "$0.00";
}

export function buildSquareBusinessPulse(inventory = {}, sales = {}) {
  const inventorySummary = inventory?.summary || {};
  const salesSummary = sales?.summary || {};
  const products = Array.isArray(inventory?.products) ? inventory.products : [];
  const topProducts = Array.isArray(sales?.top_products) ? sales.top_products : [];

  const itemCount = Number(inventorySummary.item_count || 0);
  const units = Number(inventorySummary.total_units_in_stock || 0);
  const orders = Number(salesSummary.completed_order_count || 0);
  const inventoryValue = Number(inventorySummary.inventory_value || 0);
  const totalSales = Number(salesSummary.total_collected || 0);
  const averageOrder = Number(salesSummary.average_order || 0);
  const top = topProducts[0] || null;
  const lowStock = products.filter((product) =>
    product?.track_inventory === true
    && Number(product?.quantity || 0) <= 2
  );

  const recommendations = [];
  let headline = "Your next opportunity";
  let primary = "Square is connected. GrowthWise will keep this snapshot focused on what deserves attention.";

  if (itemCount === 0) {
    headline = "Give GrowthWise products to work with";
    primary = "Square is connected, but no active catalog items were found yet.";
    recommendations.push("Add or import products in Square so GrowthWise can analyze inventory and merchandising.");
  } else if (orders === 0) {
    headline = "Turn connected inventory into your first measured campaign";
    primary = `GrowthWise found ${itemCount} catalog item${itemCount === 1 ? "" : "s"}, but no completed orders in the last 30 days.`;
    recommendations.push("Use one strong in-stock product in a promotion, then compare sales here after the campaign.");
  } else if (top?.item_name) {
    headline = `${top.item_name} is leading recent sales`;
    primary = `${top.item_name} is currently your top product by collected sales in the last 30 days.`;
    recommendations.push("Feature the current top seller in your next promotion while demand is visible.");
  }

  if (lowStock.length > 0) {
    recommendations.push(
      `${lowStock.length} tracked variation${lowStock.length === 1 ? " is" : "s are"} at 2 units or fewer; review restock before promoting them.`,
    );
  } else if (itemCount > 0) {
    recommendations.push("No tracked low-stock variation is currently flagged at 2 units or fewer.");
  }

  if (orders > 0 && averageOrder > 0) {
    recommendations.push(`Average completed order is ${money(averageOrder)}; use that as a baseline when evaluating promotions.`);
  }

  return {
    metrics: {
      sales: money(totalSales),
      orders,
      inventoryValue: money(inventoryValue),
      units,
    },
    headline,
    primary,
    recommendations: recommendations.slice(0, 3),
  };
}

function statusLabel(status) {
  return ({
    active: "Active",
    trialing: "Trialing",
    incomplete: "Checkout pending",
    past_due: "Payment needs attention",
    unpaid: "Payment needs attention",
    paused: "Paused",
    canceled: "Canceled",
    not_subscribed: "Not subscribed",
  })[status] || status || "Unknown";
}

export function createTenantWorkspaceController({
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
  navigate = (url) => globalThis.location.assign(url),
  onChange = () => {},
  trackEvent = async () => false,
} = {}) {
  let state = {
    loading: false,
    signedIn: false,
    error: "",
    profile: null,
    subscription: null,
    square: { enabled: false, loading: false, error: "", status: null },
    insights: { enabled: false, loading: false, error: "", inventory: null, sales: null, pulse: null },
    lead: { loading: false, error: "", result: null },
  };

  const publish = (next) => {
    state = { ...state, ...next };
    onChange(structuredClone(state));
    return structuredClone(state);
  };

  async function readSquareStatus({ businessId, tenantKey, subscription }) {
    if (subscription?.feature_access?.inventory_connection !== true) {
      return { enabled: false, loading: false, error: "", status: null };
    }
    try {
      const response = await fetchImpl(
        `${SQUARE_CONNECTION_ENDPOINT}?business_id=${encodeURIComponent(businessId)}`,
        { method: "GET", headers: authHeaders(tenantKey), cache: "no-store" },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.business_id !== businessId || typeof body.state !== "string") {
        throw new Error(body.error || "Square connection status is temporarily unavailable.");
      }
      return { enabled: true, loading: false, error: "", status: body };
    } catch (error) {
      return {
        enabled: true,
        loading: false,
        error: error?.message || "Square connection status is temporarily unavailable.",
        status: null,
      };
    }
  }

  async function readSquareInsights({ businessId, tenantKey, subscription, square }) {
    if (subscription?.feature_access?.inventory_connection !== true
      || square?.status?.state !== "Connected") {
      return {
        enabled: subscription?.feature_access?.inventory_connection === true,
        loading: false,
        error: "",
        inventory: null,
        sales: null,
        pulse: null,
      };
    }

    try {
      const [inventoryResponse, salesResponse] = await Promise.all([
        fetchImpl(
          `${SQUARE_INVENTORY_ENDPOINT}?business_id=${encodeURIComponent(businessId)}`,
          { method: "GET", headers: authHeaders(tenantKey), cache: "no-store" },
        ),
        fetchImpl(
          `${SQUARE_SALES_ENDPOINT}?business_id=${encodeURIComponent(businessId)}&days=30`,
          { method: "GET", headers: authHeaders(tenantKey), cache: "no-store" },
        ),
      ]);
      const [inventory, sales] = await Promise.all([
        inventoryResponse.json().catch(() => ({})),
        salesResponse.json().catch(() => ({})),
      ]);
      if (!inventoryResponse.ok || inventory?.ok !== true || inventory.business_id !== businessId) {
        throw new Error(inventory?.error || "Inventory insight is temporarily unavailable.");
      }
      if (!salesResponse.ok || sales?.ok !== true || sales.business_id !== businessId) {
        throw new Error(sales?.error || "Sales insight is temporarily unavailable.");
      }
      return {
        enabled: true,
        loading: false,
        error: "",
        inventory,
        sales,
        pulse: buildSquareBusinessPulse(inventory, sales),
      };
    } catch (error) {
      return {
        enabled: true,
        loading: false,
        error: error?.message || "Business pulse is temporarily unavailable.",
        inventory: null,
        sales: null,
        pulse: null,
      };
    }
  }

  async function authenticate({ businessId, tenantKey, persist = true }) {
    const id = String(businessId || "").trim();
    const key = String(tenantKey || "").trim();
    if (!id || !key) return publish({ loading: false, signedIn: false, error: "Enter your Workspace ID and access key.", profile: null, subscription: null });

    publish({ loading: true, error: "" });
    try {
      const profileResponse = await fetchImpl(`${PROFILE_ENDPOINT}?business_id=${encodeURIComponent(id)}`, {
        method: "GET", headers: authHeaders(key), cache: "no-store",
      });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || profile.business_id !== id || typeof profile.business_name !== "string") {
        throw new Error(profile.error || "Workspace ID or access key is incorrect.");
      }

      const statusResponse = await fetchImpl(`${STATUS_ENDPOINT}?business_id=${encodeURIComponent(id)}`, {
        method: "GET", headers: authHeaders(key), cache: "no-store",
      });
      const subscription = await statusResponse.json().catch(() => ({}));
      if (!statusResponse.ok || subscription.business_id !== id) {
        throw new Error(subscription.error || "Subscription status is temporarily unavailable.");
      }

      const square = await readSquareStatus({
        businessId: id,
        tenantKey: key,
        subscription,
      });

      const insights = await readSquareInsights({
        businessId: id,
        tenantKey: key,
        subscription,
        square,
      });

      await trackEvent("workspace_opened", { businessId: id, tenantKey: key });
      if (subscription?.access_source === "stripe" && subscription?.access_granted === true) {
        await trackEvent("checkout_completed", { businessId: id, tenantKey: key });
      }
      if (square?.status?.state === "Connected") {
        await trackEvent("square_connected", { businessId: id, tenantKey: key });
      }
      if (insights?.pulse) {
        await trackEvent("business_pulse_loaded", { businessId: id, tenantKey: key });
      }

      if (persist) saveWorkspaceCredentials({ businessId: id, tenantKey: key }, storage);
      return publish({
        loading: false,
        signedIn: true,
        error: "",
        profile,
        subscription,
        square,
        insights,
      });
    } catch (error) {
      clearWorkspaceCredentials(storage);
      return publish({
        loading: false,
        signedIn: false,
        error: error?.message || "Workspace sign-in failed.",
        profile: null,
        subscription: null,
        square: { enabled: false, loading: false, error: "", status: null },
        insights: { enabled: false, loading: false, error: "", inventory: null, sales: null, pulse: null },
      });
    }
  }

  async function restore() {
    const credentials = readWorkspaceCredentials(storage);
    if (!credentials.businessId || !credentials.tenantKey) return publish({ loading: false, signedIn: false, error: "" });
    return authenticate({ ...credentials, persist: false });
  }

  function openActivation() {
    navigate("./signup.html");
    return true;
  }

  async function openBilling() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!businessId || !tenantKey || state.subscription?.access_source !== "stripe") return false;
    publish({ loading: true, error: "" });
    try {
      const response = await fetchImpl(PORTAL_ENDPOINT, {
        method: "POST",
        headers: { ...authHeaders(tenantKey), "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: businessId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.portal_url !== "string") throw new Error(body.error || "Billing management is temporarily unavailable.");
      const url = new URL(body.portal_url);
      if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com" || url.username || url.password || url.hash) {
        throw new Error("Billing management returned an invalid destination.");
      }
      navigate(url.toString());
      return true;
    } catch (error) {
      publish({ loading: false, error: error?.message || "Billing management is temporarily unavailable." });
      return false;
    }
  }

  async function changePlan(targetPlanKey) {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    const target = String(targetPlanKey || "").trim();
    if (!businessId || !tenantKey || !["starter_monthly","growth_monthly","pro_monthly"].includes(target)) return false;
    publish({ loading: true, error: "" });
    try {
      const response = await fetchImpl(PLAN_CHANGE_ENDPOINT, {
        method: "POST",
        headers: { ...authHeaders(tenantKey), "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: businessId, plan_key: target }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.portal_url !== "string") {
        throw new Error(body.error || "Plan change is temporarily unavailable.");
      }
      const url = new URL(body.portal_url);
      if (url.protocol !== "https:" || url.hostname !== "billing.stripe.com" || url.username || url.password || url.hash) {
        throw new Error("Plan change returned an invalid destination.");
      }
      navigate(url.toString());
      return true;
    } catch (error) {
      publish({ loading: false, error: error?.message || "Plan change is temporarily unavailable." });
      return false;
    }
  }

  async function connectSquare() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!state.signedIn
      || state.subscription?.feature_access?.inventory_connection !== true
      || !businessId
      || !tenantKey) {
      return false;
    }

    publish({
      square: {
        ...state.square,
        enabled: true,
        loading: true,
        error: "",
      },
    });

    try {
      const response = await fetchImpl(SQUARE_OAUTH_START_ENDPOINT, {
        method: "POST",
        headers: {
          ...authHeaders(tenantKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ business_id: businessId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || typeof body.authorization_url !== "string") {
        throw new Error(body.error || "Square connection could not be started.");
      }

      const url = new URL(body.authorization_url);
      if (url.protocol !== "https:"
        || !["connect.squareupsandbox.com", "connect.squareup.com"].includes(url.hostname)
        || url.pathname !== "/oauth2/authorize"
        || url.username
        || url.password
        || url.hash) {
        throw new Error("Square connection returned an invalid destination.");
      }

      await trackEvent("square_connect_started", { businessId, tenantKey });
      navigate(url.toString());
      return true;
    } catch (error) {
      publish({
        square: {
          ...state.square,
          enabled: true,
          loading: false,
          error: error?.message || "Square connection could not be started.",
        },
      });
      return false;
    }
  }

  async function refreshSquareInsights() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!state.signedIn || !businessId || !tenantKey || state.square?.status?.state !== "Connected") {
      return false;
    }

    publish({
      insights: {
        ...state.insights,
        enabled: true,
        loading: true,
        error: "",
      },
    });
    const insights = await readSquareInsights({
      businessId,
      tenantKey,
      subscription: state.subscription,
      square: state.square,
    });
    publish({ insights });
    if (insights?.pulse) {
      await trackEvent("business_pulse_loaded", { businessId, tenantKey });
    }
    return Boolean(insights.pulse);
  }

  async function draftLead({ source, customerName, message }) {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    const text = String(message || "").trim();
    if (!state.signedIn || state.subscription?.access_granted !== true || !businessId || !tenantKey) {
      publish({ lead: { loading: false, error: "An active workspace is required.", result: null } });
      return false;
    }
    if (!text) {
      publish({ lead: { loading: false, error: "Enter the customer's message first.", result: null } });
      return false;
    }

    publish({ lead: { loading: true, error: "", result: null } });
    try {
      const response = await fetchImpl(`${LEAD_ENDPOINT}?business_id=${encodeURIComponent(businessId)}`, {
        method: "POST",
        headers: { ...authHeaders(tenantKey), "Content-Type": "application/json" },
        body: JSON.stringify({
          source: String(source || "Customer message").slice(0, 120),
          customer_name: String(customerName || "").trim().slice(0, 120),
          message: text.slice(0, 4000),
          automation_mode: "shadow",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || typeof body?.reply !== "string") {
        throw new Error(body?.error || "GrowthWise could not draft the reply.");
      }
      publish({ lead: { loading: false, error: "", result: body } });
      await trackEvent("ai_workflow_used", { businessId, tenantKey });
      return true;
    } catch (error) {
      publish({
        lead: {
          loading: false,
          error: error?.message || "GrowthWise could not draft the reply.",
          result: null,
        },
      });
      return false;
    }
  }

  function signOut() {
    clearWorkspaceCredentials(storage);
    return publish({
      loading: false,
      signedIn: false,
      error: "",
      profile: null,
      subscription: null,
      square: { enabled: false, loading: false, error: "", status: null },
      insights: { enabled: false, loading: false, error: "", inventory: null, sales: null, pulse: null },
      lead: { loading: false, error: "", result: null },
    });
  }

  return {
    authenticate,
    restore,
    openActivation,
    openBilling,
    changePlan,
    connectSquare,
    refreshSquareInsights,
    draftLead,
    signOut,
    getState: () => structuredClone(state),
    statusLabel,
  };
}

export function mountTenantWorkspace({ documentImpl = globalThis.document } = {}) {
  const form = documentImpl.getElementById("workspace-signin-form");
  const signedOut = documentImpl.getElementById("workspace-signed-out");
  const signedIn = documentImpl.getElementById("workspace-signed-in");
  const error = documentImpl.getElementById("workspace-error");
  const businessName = documentImpl.getElementById("workspace-business-name");
  const workspaceId = documentImpl.getElementById("workspace-id");
  const contact = documentImpl.getElementById("workspace-contact");
  const status = documentImpl.getElementById("workspace-status");
  const access = documentImpl.getElementById("workspace-access");
  const plan = documentImpl.getElementById("workspace-plan");
  const proTrial = documentImpl.getElementById("workspace-pro-trial");
  const featureGrid = documentImpl.getElementById("workspace-feature-grid");
  const planControls = documentImpl.getElementById("workspace-plan-controls");
  const planButtons = [...documentImpl.querySelectorAll("[data-plan-change]")];
  const manage = documentImpl.getElementById("workspace-manage-billing");
  const signOut = documentImpl.getElementById("workspace-signout");
  const squareCard = documentImpl.getElementById("workspace-square-card");
  const squareState = documentImpl.getElementById("workspace-square-state");
  const squareDetail = documentImpl.getElementById("workspace-square-detail");
  const squareError = documentImpl.getElementById("workspace-square-error");
  const squareConnect = documentImpl.getElementById("workspace-square-connect");
  const onboardingSummary = documentImpl.getElementById("workspace-onboarding-summary");
  const onboardingList = documentImpl.getElementById("workspace-onboarding-list");
  const journeyBanner = documentImpl.getElementById("workspace-journey-banner");
  const nextStep = documentImpl.getElementById("workspace-next-step");
  const pulseCard = documentImpl.getElementById("workspace-pulse-card");
  const pulseError = documentImpl.getElementById("workspace-pulse-error");
  const pulseLoading = documentImpl.getElementById("workspace-pulse-loading");
  const pulseContent = documentImpl.getElementById("workspace-pulse-content");
  const pulseSales = documentImpl.getElementById("workspace-pulse-sales");
  const pulseOrders = documentImpl.getElementById("workspace-pulse-orders");
  const pulseInventoryValue = documentImpl.getElementById("workspace-pulse-inventory-value");
  const pulseUnits = documentImpl.getElementById("workspace-pulse-units");
  const pulseHeadline = documentImpl.getElementById("workspace-pulse-headline");
  const pulsePrimary = documentImpl.getElementById("workspace-pulse-primary");
  const pulseRecommendations = documentImpl.getElementById("workspace-pulse-recommendations");
  const leadCard = documentImpl.getElementById("workspace-lead-card");
  const leadForm = documentImpl.getElementById("workspace-lead-form");
  const leadButton = documentImpl.getElementById("workspace-lead-submit");
  const leadStatus = documentImpl.getElementById("workspace-lead-status");
  const leadResult = documentImpl.getElementById("workspace-lead-result");
  const leadReply = documentImpl.getElementById("workspace-lead-reply");
  const leadMeta = documentImpl.getElementById("workspace-lead-meta");
  const leadFollowUp = documentImpl.getElementById("workspace-lead-followup");

  const render = (view) => {
    signedOut.hidden = view.signedIn;
    signedIn.hidden = !view.signedIn;
    error.hidden = !view.error;
    error.textContent = view.error || "";

    if (!view.signedIn) return;
    businessName.textContent = view.profile?.business_name || "Your business";
    workspaceId.textContent = view.profile?.business_id || "";
    contact.textContent = [view.profile?.contact_name, view.profile?.contact_email].filter(Boolean).join(" · ");
    status.textContent = controller.statusLabel(view.subscription?.status);
    access.textContent = view.subscription?.access_granted ? "Active" : "Locked";
    plan.textContent = view.subscription?.plan_name
      ? `${view.subscription.plan_name}${view.subscription.monthly_price_usd ? ` · ${view.subscription.monthly_price_usd}/mo` : ""}`
      : "No active plan";

    const trial = view.subscription?.pro_experience;
    const trialActive = trial?.active === true;
    proTrial.hidden = !trialActive;
    if (trialActive) {
      const end = trial.ends_at ? new Date(trial.ends_at) : null;
      const endLabel = end && Number.isFinite(end.getTime()) ? end.toLocaleDateString() : "the trial end date";
      proTrial.textContent = `Pro Experience active · ${trial.remaining_days} day${trial.remaining_days === 1 ? "" : "s"} remaining · returns to Growth on ${endLabel} unless you choose Pro.`;
    }

    const featureAccess = view.subscription?.feature_access || {};
    featureGrid.replaceChildren();
    for (const [key, label] of FEATURE_LABELS) {
      const item = documentImpl.createElement("div");
      item.className = `feature-item ${featureAccess[key] ? "included" : "locked"}`;
      const name = documentImpl.createElement("strong");
      name.textContent = label;
      const state = documentImpl.createElement("span");
      state.textContent = featureAccess[key] ? "Included" : "Locked";
      item.append(name, state);
      featureGrid.append(item);
    }

    const currentPlan = view.subscription?.plan_key || "";
    const canChangePlan = view.subscription?.access_source === "stripe"
      && ["starter_monthly","growth_monthly","pro_monthly"].includes(currentPlan)
      && view.subscription?.access_granted === true;
    planControls.hidden = !canChangePlan;
    for (const button of planButtons) {
      const target = button.dataset.planChange || "";
      button.hidden = target === currentPlan;
      button.disabled = view.loading;
    }

    manage.hidden = view.subscription?.access_source !== "stripe";
    manage.disabled = view.loading;
    const accessGranted = view.subscription?.access_granted === true;

    squareCard.hidden = view.square?.enabled !== true;
    if (view.square?.enabled === true) {
      const connectionState = view.square?.status?.state || (view.square?.loading ? "Checking…" : "Not Connected");
      squareState.textContent = connectionState;
      squareDetail.textContent = view.square?.status?.account?.display_name
        || view.square?.status?.action
        || "Connect your own Square account for tenant-specific inventory and sales.";
      squareError.hidden = !view.square?.error;
      squareError.textContent = view.square?.error || "";
      const connected = connectionState === "Connected";
      squareConnect.hidden = connected;
      squareConnect.disabled = view.square?.loading === true;
      squareConnect.textContent = view.square?.loading
        ? "Opening Square…"
        : connectionState === "Needs Attention"
          ? "Reconnect Square"
          : "Connect Square";
    }

    const squareEligible = featureAccess.inventory_connection === true;
    const squareConnected = view.square?.status?.state === "Connected";
    const pulseReady = Boolean(view.insights?.pulse);
    const setupSteps = [
      ["Workspace ready", true, "Done"],
      ["Plan active", accessGranted, accessGranted ? "Done" : "Next"],
      ...(squareEligible
        ? [
            ["Square connected", squareConnected, squareConnected ? "Done" : "Next"],
            ["Business pulse ready", pulseReady, pulseReady ? "Done" : "Next"],
          ]
        : [["Square connection", false, "Growth+"]]),
    ];
    const completedSteps = setupSteps.filter(([, done]) => done).length;
    onboardingSummary.textContent = `${completedSteps} of ${setupSteps.length} setup steps complete. ${pulseReady ? "Your workspace is already turning connected data into decisions." : "Finish the next step to unlock more value."}`;
    onboardingList.replaceChildren();
    setupSteps.forEach(([label, done, tag], index) => {
      const item = documentImpl.createElement("div");
      const isNext = !done && setupSteps.slice(0, index).every(([, previousDone]) => previousDone);
      item.className = `progress-item ${done ? "done" : isNext ? "next" : ""}`;
      const name = documentImpl.createElement("strong");
      name.textContent = label;
      const stateLabel = documentImpl.createElement("span");
      stateLabel.textContent = tag;
      item.append(name, stateLabel);
      onboardingList.append(item);
    });

    const query = new URLSearchParams(globalThis.location?.search || "");
    const returnedFromSquare = query.get("square") === "connected";
    const firstRun = query.get("onboarding") === "1";
    journeyBanner.hidden = true;
    journeyBanner.textContent = "";

    nextStep.hidden = false;
    nextStep.disabled = view.loading || view.square?.loading === true || view.insights?.loading === true;

    if (!accessGranted) {
      nextStep.dataset.nextAction = "activate";
      nextStep.textContent = "Activate access";
      if (firstRun) {
        journeyBanner.hidden = false;
        journeyBanner.textContent = "Your workspace is ready. Activate access to continue setup.";
      }
    } else if (squareEligible && !squareConnected) {
      nextStep.dataset.nextAction = "connect-square";
      nextStep.textContent = "Connect Square";
      if (firstRun) {
        journeyBanner.hidden = false;
        journeyBanner.textContent = "Access is active. Connect this business's Square account to unlock your first Business Pulse.";
      }
    } else if (squareConnected && !pulseReady) {
      nextStep.dataset.nextAction = "refresh-insights";
      nextStep.textContent = view.insights?.error ? "Retry Business Pulse" : "Load Business Pulse";
      if (returnedFromSquare) {
        journeyBanner.hidden = false;
        journeyBanner.textContent = "Square is connected. GrowthWise is turning your business data into your first Business Pulse.";
      }
    } else {
      nextStep.dataset.nextAction = "lead";
      nextStep.textContent = "Try AI lead reply";
      if (returnedFromSquare || firstRun) {
        journeyBanner.hidden = false;
        journeyBanner.textContent = "Setup is complete. Your Business Pulse is ready—now try a customer-facing workflow.";
      }
    }

    pulseCard.hidden = !squareConnected;
    if (squareConnected) {
      pulseLoading.hidden = view.insights?.loading !== true;
      pulseError.hidden = !view.insights?.error;
      pulseError.textContent = view.insights?.error || "";
      pulseContent.hidden = !view.insights?.pulse || view.insights?.loading === true;
      const pulse = view.insights?.pulse;
      if (pulse) {
        pulseSales.textContent = pulse.metrics.sales;
        pulseOrders.textContent = String(pulse.metrics.orders);
        pulseInventoryValue.textContent = pulse.metrics.inventoryValue;
        pulseUnits.textContent = String(pulse.metrics.units);
        pulseHeadline.textContent = pulse.headline;
        pulsePrimary.textContent = pulse.primary;
        pulseRecommendations.replaceChildren();
        for (const recommendation of pulse.recommendations) {
          const item = documentImpl.createElement("li");
          item.textContent = recommendation;
          pulseRecommendations.append(item);
        }
      }
    }

    leadCard.hidden = !accessGranted;
    leadButton.disabled = view.lead?.loading === true;
    leadButton.textContent = view.lead?.loading ? "Drafting…" : "Draft safe reply";
    leadStatus.hidden = !view.lead?.error;
    leadStatus.textContent = view.lead?.error || "";
    leadResult.hidden = !view.lead?.result;
    if (view.lead?.result) {
      leadReply.textContent = view.lead.result.reply || "";
      leadMeta.textContent = [
        view.lead.result.intent ? `Intent: ${view.lead.result.intent}` : "",
        view.lead.result.risk_level ? `Risk: ${view.lead.result.risk_level}` : "",
        view.lead.result.decision ? `Decision: ${view.lead.result.decision}` : "",
      ].filter(Boolean).join(" · ");
      leadFollowUp.textContent = view.lead.result.follow_up_action || "";
    }
  };

  const controller = createTenantWorkspaceController({
    onChange: render,
    trackEvent: createOnboardingTracker(),
  });
  render(controller.getState());

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    await controller.authenticate({
      businessId: data.get("business_id"),
      tenantKey: data.get("tenant_key"),
    });
  });
  manage?.addEventListener("click", () => controller.openBilling());
  squareConnect?.addEventListener("click", () => controller.connectSquare());
  nextStep?.addEventListener("click", async () => {
    const action = nextStep.dataset.nextAction || "";
    if (action === "activate") {
      controller.openActivation();
      return;
    }
    if (action === "connect-square") {
      await controller.connectSquare();
      return;
    }
    if (action === "refresh-insights") {
      await controller.refreshSquareInsights();
      return;
    }
    if (action === "lead") {
      leadCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      leadForm?.querySelector?.("textarea[name='message']")?.focus?.();
    }
  });
  planButtons.forEach((button) => button.addEventListener("click", () => controller.changePlan(button.dataset.planChange)));
  leadForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(leadForm);
    await controller.draftLead({
      source: data.get("source"),
      customerName: data.get("customer_name"),
      message: data.get("message"),
    });
  });
  signOut?.addEventListener("click", () => controller.signOut());
  controller.restore();
  return controller;
}

if (typeof document !== "undefined") mountTenantWorkspace();
