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
const CONNECTOR_SESSION_START_ENDPOINT = "/.netlify/functions/tenant-connector-session-start";
const LOGIN_REQUEST_ENDPOINT = "/.netlify/functions/tenant-login-request";
const TENANT_SESSION_ENDPOINT = "/.netlify/functions/tenant-session";
const TENANT_SESSION_LOGOUT_ENDPOINT = "/.netlify/functions/tenant-session-logout";
const FACEBOOK_CONNECTION_ENDPOINT = "/.netlify/functions/tenant-facebook-connection";
const FACEBOOK_PUBLISH_ENDPOINT = "/.netlify/functions/tenant-facebook-publish";
const FIRST_WIN_ENDPOINT = "/.netlify/functions/tenant-first-win";
const BUSINESS_ASSISTANT_ENDPOINT = "/.netlify/functions/tenant-business-assistant";

export function businessStarterKit(businessType = "other") {
  const kits = {
    retail: [
      { kind: "social_post", label: "Promote a product", prompt: "Create a social post for a product or display I want customers to notice." },
      { kind: "customer_reply", label: "Answer a product question", prompt: "Customer asked: " },
      { kind: "assistant", label: "Plan this week's promotion", prompt: "Help me decide what to promote this week and what information you need from me." },
    ],
    bakery_food: [
      { kind: "social_post", label: "Promote a seasonal treat", prompt: "Create a social post for a seasonal treat, preorder, or class I want customers to notice." },
      { kind: "customer_reply", label: "Answer a custom-order question", prompt: "Customer asked about a custom order: " },
      { kind: "assistant", label: "Plan the next seasonal push", prompt: "Help me choose what to promote next for my bakery and what information you need from me." },
    ],
    auto_dealer: [
      { kind: "social_post", label: "Feature a vehicle", prompt: "Create a social post for a vehicle I want shoppers to notice." },
      { kind: "customer_reply", label: "Answer a vehicle inquiry", prompt: "Customer asked about a vehicle: " },
      { kind: "assistant", label: "Plan lead follow-up", prompt: "Help me improve follow-up on vehicle inquiries and tell me what information you need from me." },
    ],
    service: [
      { kind: "social_post", label: "Promote openings", prompt: "Create a social post that helps customers notice an available service or upcoming openings." },
      { kind: "customer_reply", label: "Answer a scheduling question", prompt: "Customer asked about scheduling: " },
      { kind: "assistant", label: "Improve inquiry follow-up", prompt: "Help me turn more service inquiries into booked appointments and tell me what information you need from me." },
    ],
    other: [
      { kind: "social_post", label: "Create a promotion", prompt: "Create a social post for something I want customers to notice." },
      { kind: "customer_reply", label: "Answer a customer", prompt: "Customer asked: " },
      { kind: "assistant", label: "Choose my next priority", prompt: "Help me decide the most useful thing to work on next for my business." },
    ],
  };
  const selected = kits[businessType] || kits.other;
  return selected.map((item) => ({ ...item }));
}

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

export function saveWorkspaceCredentials({ businessId, tenantKey = "" }, storage = globalThis.sessionStorage) {
  storage?.setItem("growthwise_business_id", businessId);
  if (tenantKey) storage?.setItem("growthwise_tenant_key", tenantKey);
  else storage?.removeItem("growthwise_tenant_key");
}

export function clearWorkspaceCredentials(storage = globalThis.sessionStorage) {
  storage?.removeItem("growthwise_business_id");
  storage?.removeItem("growthwise_tenant_key");
}

function authHeaders(tenantKey) {
  const key = String(tenantKey || "").trim();
  return key ? { "X-GrowthWise-Tenant-Key": key } : {};
}

export function createOnboardingTracker({
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
} = {}) {
  return async function trackOnboardingEvent(eventName, { businessId, tenantKey } = {}) {
    const name = String(eventName || "").trim();
    const id = String(businessId || "").trim();
    const key = String(tenantKey || "").trim();
    if (!name || !id) return false;

    const eventDay = new Date().toISOString().slice(0, 10);
    const dedupeKey = `growthwise_onboarding_event:${id}:${name}:${eventDay}`;
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
        credentials: "same-origin",
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

export function buildOnboardingSteps({
  accessGranted = false,
  firstWinReady = false,
  squareEligible = false,
  squareConnected = false,
  squareSkipped = false,
  pulseReady = false,
} = {}) {
  const steps = [
    ["Workspace ready", true, "Done"],
    ["Plan active", accessGranted, accessGranted ? "Done" : "Next"],
  ];
  if (accessGranted) {
    steps.push(["First useful result", firstWinReady, firstWinReady ? "Done" : "Next"]);
  }
  if (squareEligible) {
    steps.push(
      ["Square connected", squareConnected, squareConnected ? "Done" : squareSkipped ? "Later" : "Next"],
      ["Business pulse ready", pulseReady, pulseReady ? "Done" : squareSkipped && !squareConnected ? "Later" : "Next"],
    );
  }
  return steps;
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
    square: { enabled: false, loading: false, error: "", status: null, skipped: false },
    insights: { enabled: false, loading: false, error: "", inventory: null, sales: null, pulse: null },
    channels: { loading: false, error: "" },
    emailLogin: { loading: false, error: "", message: "" },
    lead: { loading: false, error: "", result: null },
    facebook: {
      enabled: false,
      loading: false,
      error: "",
      status: null,
      publishing: false,
      publishError: "",
      result: null,
    },
    firstWin: {
      completed: false,
      loading: false,
      error: "",
      result: null,
    },
    assistant: {
      loading: false,
      error: "",
      messages: [],
      result: null,
    },
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
        { method: "GET", headers: authHeaders(tenantKey), cache: "no-store", credentials: "same-origin" },
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

  async function readFacebookStatus({ businessId, tenantKey, subscription }) {
    if (subscription?.feature_access?.automated_publishing !== true) {
      return {
        enabled: false,
        loading: false,
        error: "",
        status: null,
        publishing: false,
        publishError: "",
        result: null,
      };
    }
    try {
      const response = await fetchImpl(
        `${FACEBOOK_CONNECTION_ENDPOINT}?business_id=${encodeURIComponent(businessId)}`,
        {
          method: "GET",
          headers: authHeaders(tenantKey),
          cache: "no-store",
          credentials: "same-origin",
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.business_id !== businessId || typeof body.state !== "string") {
        throw new Error(body.error || "Facebook connection status is temporarily unavailable.");
      }
      return {
        enabled: true,
        loading: false,
        error: "",
        status: body,
        publishing: false,
        publishError: "",
        result: null,
      };
    } catch (error) {
      return {
        enabled: true,
        loading: false,
        error: error?.message || "Facebook connection status is temporarily unavailable.",
        status: null,
        publishing: false,
        publishError: "",
        result: null,
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
          { method: "GET", headers: authHeaders(tenantKey), cache: "no-store", credentials: "same-origin" },
        ),
        fetchImpl(
          `${SQUARE_SALES_ENDPOINT}?business_id=${encodeURIComponent(businessId)}&days=30`,
          { method: "GET", headers: authHeaders(tenantKey), cache: "no-store", credentials: "same-origin" },
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

  async function authenticate({ businessId, tenantKey = "", persist = true, sessionAuth = false }) {
    const id = String(businessId || "").trim();
    const key = String(tenantKey || "").trim();
    if (!id || (!key && !sessionAuth)) {
      return publish({
        loading: false,
        signedIn: false,
        error: "Enter your Workspace ID and access key.",
        profile: null,
        subscription: null,
      });
    }

    publish({ loading: true, error: "" });
    try {
      const profileResponse = await fetchImpl(`${PROFILE_ENDPOINT}?business_id=${encodeURIComponent(id)}`, {
        method: "GET", headers: authHeaders(key), cache: "no-store", credentials: "same-origin",
      });
      const profile = await profileResponse.json().catch(() => ({}));
      if (!profileResponse.ok || profile.business_id !== id || typeof profile.business_name !== "string") {
        throw new Error(profile.error || "Workspace ID or access key is incorrect.");
      }

      const statusResponse = await fetchImpl(`${STATUS_ENDPOINT}?business_id=${encodeURIComponent(id)}`, {
        method: "GET", headers: authHeaders(key), cache: "no-store", credentials: "same-origin",
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
      square.skipped = storage?.getItem(`growthwise_square_skip:${id}`) === "1";

      const insights = await readSquareInsights({
        businessId: id,
        tenantKey: key,
        subscription,
        square,
      });

      const facebook = await readFacebookStatus({
        businessId: id,
        tenantKey: key,
        subscription,
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
      else if (sessionAuth) saveWorkspaceCredentials({ businessId: id, tenantKey: "" }, storage);
      const firstWinCompleted = storage?.getItem(`growthwise_first_win:${id}`) === "1";
      return publish({
        loading: false,
        signedIn: true,
        error: "",
        profile,
        subscription,
        square,
        insights,
        facebook,
        firstWin: {
          completed: firstWinCompleted,
          loading: false,
          error: "",
          result: null,
        },
        assistant: {
          loading: false,
          error: "",
          messages: [],
          result: null,
        },
      });
    } catch (error) {
      clearWorkspaceCredentials(storage);
      return publish({
        loading: false,
        signedIn: false,
        error: error?.message || "Workspace sign-in failed.",
        profile: null,
        subscription: null,
        square: { enabled: false, loading: false, error: "", status: null, skipped: false },
        insights: { enabled: false, loading: false, error: "", inventory: null, sales: null, pulse: null },
        facebook: {
          enabled: false,
          loading: false,
          error: "",
          status: null,
          publishing: false,
          publishError: "",
          result: null,
        },
        firstWin: {
          completed: false,
          loading: false,
          error: "",
          result: null,
        },
        assistant: {
          loading: false,
          error: "",
          messages: [],
          result: null,
        },
      });
    }
  }

  async function restore() {
    const credentials = readWorkspaceCredentials(storage);
    if (credentials.businessId && credentials.tenantKey) {
      return authenticate({ ...credentials, persist: false });
    }

    try {
      const response = await fetchImpl(TENANT_SESSION_ENDPOINT, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && body?.ok === true && typeof body?.business_id === "string" && body.business_id) {
        saveWorkspaceCredentials({ businessId: body.business_id, tenantKey: "" }, storage);
        return authenticate({
          businessId: body.business_id,
          tenantKey: "",
          persist: false,
          sessionAuth: true,
        });
      }
    } catch {}

    clearWorkspaceCredentials(storage);
    return publish({ loading: false, signedIn: false, error: "" });
  }

  async function requestEmailSignIn(email) {
    const value = String(email || "").trim().toLowerCase();
    if (!value || !value.includes("@")) {
      publish({ emailLogin: { loading: false, error: "Enter a valid email address.", message: "" } });
      return false;
    }

    publish({ emailLogin: { loading: true, error: "", message: "" } });
    try {
      const response = await fetchImpl(LOGIN_REQUEST_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error || "Email sign-in is temporarily unavailable.");
      }
      publish({
        emailLogin: {
          loading: false,
          error: "",
          message: body.message || "If that email belongs to a workspace, a secure sign-in link will arrive shortly.",
        },
      });
      return true;
    } catch (error) {
      publish({
        emailLogin: {
          loading: false,
          error: error?.message || "Email sign-in is temporarily unavailable.",
          message: "",
        },
      });
      return false;
    }
  }

  function openActivation() {
    navigate("./signup.html");
    return true;
  }

  async function openBilling() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!businessId || state.subscription?.access_source !== "stripe") return false;
    publish({ loading: true, error: "" });
    try {
      const response = await fetchImpl(PORTAL_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
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
    if (!businessId || !["starter_monthly","growth_monthly","pro_monthly"].includes(target)) return false;
    publish({ loading: true, error: "" });
    try {
      const response = await fetchImpl(PLAN_CHANGE_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
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
      || !businessId) {
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
        credentials: "same-origin",
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

  async function openConnectorSetup() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!state.signedIn
      || state.subscription?.feature_access?.unified_inbox !== true
      || !businessId) {
      return false;
    }

    publish({ channels: { loading: true, error: "" } });
    try {
      const response = await fetchImpl(CONNECTOR_SESSION_START_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          ...authHeaders(tenantKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ business_id: businessId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || body?.connection_url !== "/connect-accounts.html") {
        throw new Error(body?.error || "Customer channel setup is temporarily unavailable.");
      }
      navigate(body.connection_url);
      return true;
    } catch (error) {
      publish({
        channels: {
          loading: false,
          error: error?.message || "Customer channel setup is temporarily unavailable.",
        },
      });
      return false;
    }
  }

  function skipSquare() {
    const { businessId } = readWorkspaceCredentials(storage);
    if (!state.signedIn
      || state.subscription?.feature_access?.inventory_connection !== true
      || state.square?.status?.state === "Connected"
      || !businessId) {
      return false;
    }
    storage?.setItem(`growthwise_square_skip:${businessId}`, "1");
    publish({
      square: {
        ...state.square,
        skipped: true,
      },
    });
    return true;
  }

  async function refreshSquareInsights() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!state.signedIn || !businessId || state.square?.status?.state !== "Connected") {
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

  async function askNarleo(question) {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    const text = String(question || "").trim();
    if (!state.signedIn
      || state.subscription?.feature_access?.ai_business_assistant !== true
      || !businessId) {
      publish({
        assistant: {
          ...state.assistant,
          loading: false,
          error: "Narleo business assistant is not available for this workspace.",
        },
      });
      return false;
    }
    if (!text) {
      publish({
        assistant: {
          ...state.assistant,
          loading: false,
          error: "Ask Narleo a business question first.",
        },
      });
      return false;
    }

    const history = (state.assistant?.messages || []).slice(-6).map((message) => ({
      role: message.role === "assistant" ? "assistant" : "user",
      text: String(message.text || "").slice(0, 1800),
    }));

    publish({
      assistant: {
        ...state.assistant,
        loading: true,
        error: "",
      },
    });

    try {
      const response = await fetchImpl(BUSINESS_ASSISTANT_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          ...authHeaders(tenantKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          business_id: businessId,
          question: text.slice(0, 4000),
          history,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok !== true || result.business_id !== businessId
        || typeof result.answer !== "string") {
        throw new Error(result?.error || "Narleo could not answer that right now.");
      }

      const messages = [
        ...(state.assistant?.messages || []),
        { role: "user", text },
        { role: "assistant", text: result.answer },
      ].slice(-12);

      publish({
        assistant: {
          loading: false,
          error: "",
          messages,
          result,
        },
      });
      await trackEvent("ai_workflow_used", { businessId, tenantKey });
      return true;
    } catch (error) {
      publish({
        assistant: {
          ...state.assistant,
          loading: false,
          error: error?.message || "Narleo could not answer that right now.",
        },
      });
      return false;
    }
  }

  async function createFirstWin({
    task,
    prompt,
    imageDataUrl = "",
  } = {}) {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    const kind = String(task || "").trim();
    const context = String(prompt || "").trim();
    if (!state.signedIn || !businessId || state.subscription?.access_granted !== true) {
      publish({
        firstWin: {
          ...state.firstWin,
          loading: false,
          error: "An active workspace is required.",
          result: null,
        },
      });
      return false;
    }
    if (!["social_post", "customer_reply"].includes(kind) || !context) {
      publish({
        firstWin: {
          ...state.firstWin,
          loading: false,
          error: "Choose a task and add a little context.",
          result: null,
        },
      });
      return false;
    }

    publish({
      firstWin: {
        ...state.firstWin,
        loading: true,
        error: "",
        result: null,
      },
    });

    try {
      const body = {
        business_id: businessId,
        task: kind,
        prompt: context.slice(0, 4000),
      };
      if (kind === "social_post" && imageDataUrl) {
        body.image_data_url = String(imageDataUrl);
      }
      const response = await fetchImpl(FIRST_WIN_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          ...authHeaders(tenantKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok !== true || result.business_id !== businessId) {
        throw new Error(result?.error || "Narleo could not create the first result.");
      }
      storage?.setItem(`growthwise_first_win:${businessId}`, "1");
      publish({
        firstWin: {
          completed: true,
          loading: false,
          error: "",
          result,
        },
      });
      await trackEvent("first_win_created", { businessId, tenantKey });
      await trackEvent("ai_workflow_used", { businessId, tenantKey });
      return true;
    } catch (error) {
      publish({
        firstWin: {
          ...state.firstWin,
          loading: false,
          error: error?.message || "Narleo could not create the first result.",
          result: null,
        },
      });
      return false;
    }
  }

  async function refreshFacebookStatus() {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    if (!state.signedIn
      || state.subscription?.feature_access?.automated_publishing !== true
      || !businessId) {
      return false;
    }
    publish({
      facebook: {
        ...state.facebook,
        enabled: true,
        loading: true,
        error: "",
      },
    });
    const facebook = await readFacebookStatus({
      businessId,
      tenantKey,
      subscription: state.subscription,
    });
    publish({ facebook: { ...facebook, result: state.facebook?.result || null } });
    return facebook.status?.state === "Connected";
  }

  async function publishFacebook({ message, imageDataUrl = "", reviewed = false } = {}) {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    const text = String(message || "").trim();
    if (!state.signedIn
      || state.subscription?.feature_access?.automated_publishing !== true
      || !businessId) {
      publish({
        facebook: {
          ...state.facebook,
          publishError: "Facebook publishing is not available for this workspace.",
          result: null,
        },
      });
      return false;
    }
    if (state.facebook?.status?.state !== "Connected") {
      publish({
        facebook: {
          ...state.facebook,
          publishError: "Connect this business's Facebook Page before publishing.",
          result: null,
        },
      });
      return false;
    }
    if (!reviewed || !text) {
      publish({
        facebook: {
          ...state.facebook,
          publishError: "Review the post copy and confirm it before publishing.",
          result: null,
        },
      });
      return false;
    }

    publish({
      facebook: {
        ...state.facebook,
        publishing: true,
        publishError: "",
        result: null,
      },
    });
    try {
      const body = {
        business_id: businessId,
        reviewed: true,
        message: text.slice(0, 5000),
        expected_page_name: String(state.facebook?.status?.account?.page_name || "").slice(0, 220),
      };
      if (imageDataUrl) body.image_data_url = String(imageDataUrl);

      const response = await fetchImpl(FACEBOOK_PUBLISH_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          ...authHeaders(tenantKey),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.ok !== true || result.business_id !== businessId) {
        throw Object.assign(
          new Error(result?.error || "Facebook could not publish the reviewed post."),
          { code: result?.code || "" },
        );
      }
      publish({
        facebook: {
          ...state.facebook,
          publishing: false,
          publishError: "",
          result,
        },
      });
      return true;
    } catch (error) {
      const needsAttention = [
        "FACEBOOK_RECONNECT_REQUIRED",
        "FACEBOOK_PUBLISHING_PERMISSION_REQUIRED",
        "FACEBOOK_PAGE_MISMATCH",
      ].includes(error?.code);
      publish({
        facebook: {
          ...state.facebook,
          publishing: false,
          publishError: error?.message || "Facebook could not publish the reviewed post.",
          result: null,
          status: needsAttention
            ? {
                ...(state.facebook?.status || {}),
                state: "Needs Attention",
                action: "Reconnect Facebook before publishing again.",
              }
            : state.facebook?.status,
        },
      });
      return false;
    }
  }

  async function draftLead({ source, customerName, message }) {
    const { businessId, tenantKey } = readWorkspaceCredentials(storage);
    const text = String(message || "").trim();
    if (!state.signedIn || state.subscription?.access_granted !== true || !businessId) {
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
        credentials: "same-origin",
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

  async function signOut() {
    try {
      await fetchImpl(TENANT_SESSION_LOGOUT_ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {}
    clearWorkspaceCredentials(storage);
    return publish({
      loading: false,
      signedIn: false,
      error: "",
      profile: null,
      subscription: null,
      square: { enabled: false, loading: false, error: "", status: null },
      insights: { enabled: false, loading: false, error: "", inventory: null, sales: null, pulse: null },
      channels: { loading: false, error: "" },
      emailLogin: { loading: false, error: "", message: "" },
      lead: { loading: false, error: "", result: null },
      facebook: {
        enabled: false,
        loading: false,
        error: "",
        status: null,
        publishing: false,
        publishError: "",
        result: null,
      },
      firstWin: {
        completed: false,
        loading: false,
        error: "",
        result: null,
      },
      assistant: {
        loading: false,
        error: "",
        messages: [],
        result: null,
      },
    });
  }

  return {
    authenticate,
    restore,
    requestEmailSignIn,
    openActivation,
    openBilling,
    changePlan,
    connectSquare,
    skipSquare,
    refreshSquareInsights,
    openConnectorSetup,
    askNarleo,
    createFirstWin,
    refreshFacebookStatus,
    publishFacebook,
    draftLead,
    signOut,
    getState: () => structuredClone(state),
    statusLabel,
  };
}

export function mountTenantWorkspace({ documentImpl = globalThis.document } = {}) {
  const form = documentImpl.getElementById("workspace-signin-form");
  const emailSigninForm = documentImpl.getElementById("workspace-email-signin-form");
  const emailSigninButton = documentImpl.getElementById("workspace-email-signin-submit");
  const emailSigninStatus = documentImpl.getElementById("workspace-email-signin-status");
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
  const squareSkip = documentImpl.getElementById("workspace-square-skip");
  const onboardingSummary = documentImpl.getElementById("workspace-onboarding-summary");
  const onboardingList = documentImpl.getElementById("workspace-onboarding-list");
  const journeyBanner = documentImpl.getElementById("workspace-journey-banner");
  const nextStep = documentImpl.getElementById("workspace-next-step");
  const channelsCard = documentImpl.getElementById("workspace-channels-card");
  const channelsError = documentImpl.getElementById("workspace-channels-error");
  const channelsOpen = documentImpl.getElementById("workspace-channels-open");
  const starterKit = documentImpl.getElementById("workspace-starter-kit");
  const firstWinCard = documentImpl.getElementById("workspace-first-win-card");
  const firstWinForm = documentImpl.getElementById("workspace-first-win-form");
  const firstWinTask = documentImpl.getElementById("workspace-first-win-task");
  const firstWinPromptLabel = documentImpl.getElementById("workspace-first-win-prompt-label");
  const firstWinPrompt = documentImpl.getElementById("workspace-first-win-prompt");
  const firstWinImageField = documentImpl.getElementById("workspace-first-win-image-field");
  const firstWinImage = documentImpl.getElementById("workspace-first-win-image");
  const firstWinPreview = documentImpl.getElementById("workspace-first-win-preview");
  const firstWinSubmit = documentImpl.getElementById("workspace-first-win-submit");
  const firstWinStatus = documentImpl.getElementById("workspace-first-win-status");
  const firstWinResult = documentImpl.getElementById("workspace-first-win-result");
  const firstWinTitle = documentImpl.getElementById("workspace-first-win-title");
  const firstWinPrimary = documentImpl.getElementById("workspace-first-win-primary");
  const firstWinSecondaryWrap = documentImpl.getElementById("workspace-first-win-secondary-wrap");
  const firstWinSecondary = documentImpl.getElementById("workspace-first-win-secondary");
  const firstWinCopy = documentImpl.getElementById("workspace-first-win-copy");
  const firstWinCopySecondary = documentImpl.getElementById("workspace-first-win-copy-secondary");
  const firstWinUseFacebook = documentImpl.getElementById("workspace-first-win-use-facebook");
  const firstWinNote = documentImpl.getElementById("workspace-first-win-note");
  const firstWinNext = documentImpl.getElementById("workspace-first-win-next");
  const assistantCard = documentImpl.getElementById("workspace-assistant-card");
  const assistantThread = documentImpl.getElementById("workspace-assistant-thread");
  const assistantForm = documentImpl.getElementById("workspace-assistant-form");
  const assistantQuestion = documentImpl.getElementById("workspace-assistant-question");
  const assistantSubmit = documentImpl.getElementById("workspace-assistant-submit");
  const assistantStatus = documentImpl.getElementById("workspace-assistant-status");
  const assistantAction = documentImpl.getElementById("workspace-assistant-action");
  const assistantData = documentImpl.getElementById("workspace-assistant-data");
  const assistantFollowups = documentImpl.getElementById("workspace-assistant-followups");
  const facebookCard = documentImpl.getElementById("workspace-facebook-card");
  const facebookState = documentImpl.getElementById("workspace-facebook-state");
  const facebookDetail = documentImpl.getElementById("workspace-facebook-detail");
  const facebookError = documentImpl.getElementById("workspace-facebook-error");
  const facebookConnect = documentImpl.getElementById("workspace-facebook-connect");
  const facebookRefresh = documentImpl.getElementById("workspace-facebook-refresh");
  const facebookForm = documentImpl.getElementById("workspace-facebook-form");
  const facebookImage = documentImpl.getElementById("workspace-facebook-image");
  const facebookMessage = documentImpl.getElementById("workspace-facebook-message");
  const facebookPreview = documentImpl.getElementById("workspace-facebook-preview");
  const facebookReviewed = documentImpl.getElementById("workspace-facebook-reviewed");
  const facebookPublish = documentImpl.getElementById("workspace-facebook-publish");
  const facebookPublishStatus = documentImpl.getElementById("workspace-facebook-publish-status");
  const facebookResult = documentImpl.getElementById("workspace-facebook-result");
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

  let facebookImageDataUrl = "";
  let firstWinImageDataUrl = "";

  const render = (view) => {
    signedOut.hidden = view.signedIn;
    signedIn.hidden = !view.signedIn;
    error.hidden = !view.error;
    error.textContent = view.error || "";
    if (emailSigninButton) {
      emailSigninButton.disabled = view.emailLogin?.loading === true;
      emailSigninButton.textContent = view.emailLogin?.loading === true
        ? "Sending secure link…"
        : "Email me a sign-in link";
    }
    if (emailSigninStatus) {
      const loginText = view.emailLogin?.error || view.emailLogin?.message || "";
      emailSigninStatus.hidden = !loginText;
      emailSigninStatus.textContent = loginText;
      emailSigninStatus.className = view.emailLogin?.error ? "status" : "plan-banner";
    }

    if (!view.signedIn) return;
    businessName.textContent = view.profile?.business_name || "Your business";

    starterKit.replaceChildren();
    for (const item of businessStarterKit(view.profile?.business_type || "other")) {
      const button = documentImpl.createElement("button");
      button.type = "button";
      button.className = "button secondary";
      button.textContent = item.label;
      button.dataset.starterKind = item.kind;
      button.dataset.starterPrompt = item.prompt;
      button.addEventListener("click", () => {
        if (item.kind === "assistant") {
          assistantQuestion.value = item.prompt;
          assistantCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
          assistantQuestion?.focus?.();
          return;
        }
        firstWinTask.value = item.kind;
        updateFirstWinTaskUI();
        firstWinPrompt.value = item.prompt;
        firstWinCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        firstWinPrompt?.focus?.();
      });
      starterKit.append(button);
    }
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
      squareSkip.hidden = connected;
      squareSkip.disabled = view.square?.loading === true || view.square?.skipped === true;
      squareSkip.textContent = view.square?.skipped === true ? "We'll do this later" : "Do this later";
    }

    const squareEligible = featureAccess.inventory_connection === true;
    const squareConnected = view.square?.status?.state === "Connected";
    const pulseReady = Boolean(view.insights?.pulse);
    const firstWinReady = view.firstWin?.completed === true;
    const setupSteps = buildOnboardingSteps({
      accessGranted,
      firstWinReady,
      squareEligible,
      squareConnected,
      squareSkipped: view.square?.skipped === true,
      pulseReady,
    });
    const completedSteps = setupSteps.filter(([, done]) => done).length;
    onboardingSummary.textContent = `${completedSteps} of ${setupSteps.length} setup steps complete. ${pulseReady ? "Your workspace is already turning connected data into decisions." : "Finish the next step to unlock more value."}`;
    onboardingList.replaceChildren();
    setupSteps.forEach(([label, done, tag], index) => {
      const item = documentImpl.createElement("div");
      const isNext = !done && tag === "Next";
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
    const returnedFromSignin = query.get("signin") === "success";
    const firstRun = query.get("onboarding") === "1";
    journeyBanner.hidden = !returnedFromSignin;
    journeyBanner.textContent = returnedFromSignin
      ? "You're signed in securely. Continue where you left off."
      : "";

    nextStep.hidden = false;
    nextStep.disabled = view.loading || view.square?.loading === true || view.insights?.loading === true;

    if (!accessGranted) {
      nextStep.dataset.nextAction = "activate";
      nextStep.textContent = "Activate access";
      if (firstRun) {
        journeyBanner.hidden = false;
        journeyBanner.textContent = "Your workspace is ready. Activate access to continue setup.";
      }
    } else if (!firstWinReady) {
      nextStep.dataset.nextAction = "first-win";
      nextStep.textContent = "Try Narleo now";
      if (firstRun) {
        journeyBanner.hidden = false;
        journeyBanner.textContent = "Your access is active. Get a useful result now—no integrations required.";
      }
    } else if (squareEligible && !squareConnected && view.square?.skipped !== true) {
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

    firstWinCard.hidden = !accessGranted;
    if (accessGranted) {
      firstWinSubmit.disabled = view.firstWin?.loading === true;
      firstWinSubmit.textContent = view.firstWin?.loading === true
        ? "Creating…"
        : view.firstWin?.completed === true
          ? "Create another result"
          : "Create my first result";
      firstWinStatus.hidden = !view.firstWin?.error;
      firstWinStatus.textContent = view.firstWin?.error || "";
      firstWinResult.hidden = !view.firstWin?.result;
      if (view.firstWin?.result) {
        firstWinTitle.textContent = view.firstWin.result.title || "Your result";
        firstWinPrimary.textContent = view.firstWin.result.primary_text || "";
        const secondary = view.firstWin.result.secondary_text || "";
        firstWinSecondaryWrap.hidden = !secondary;
        firstWinSecondary.textContent = secondary;
        const socialResult = view.firstWin.result.task === "social_post";
        firstWinCopy.textContent = socialResult ? "Copy Facebook draft" : "Copy reply";
        firstWinCopySecondary.hidden = !secondary;
        firstWinUseFacebook.hidden = !(socialResult && featureAccess.automated_publishing === true);
        firstWinNote.textContent = view.firstWin.result.note || "";
        firstWinNext.textContent = view.firstWin.result.next_step || "";
      }
    }

    const assistantEligible = featureAccess.ai_business_assistant === true;
    assistantCard.hidden = !assistantEligible;
    if (assistantEligible) {
      assistantSubmit.disabled = view.assistant?.loading === true;
      assistantSubmit.textContent = view.assistant?.loading === true ? "Thinking…" : "Ask Narleo";
      assistantStatus.hidden = !view.assistant?.error;
      assistantStatus.textContent = view.assistant?.error || "";

      assistantThread.replaceChildren();
      for (const message of view.assistant?.messages || []) {
        const item = documentImpl.createElement("div");
        item.className = message.role === "assistant" ? "reply-box" : "plan-banner";
        const who = documentImpl.createElement("strong");
        who.textContent = message.role === "assistant" ? "Narleo" : "You";
        const body = documentImpl.createElement("div");
        body.textContent = message.text || "";
        body.style.marginTop = "6px";
        body.style.whiteSpace = "pre-wrap";
        item.append(who, body);
        assistantThread.append(item);
      }

      const result = view.assistant?.result;
      assistantAction.hidden = !result?.recommended_action;
      assistantAction.textContent = result?.recommended_action
        ? "Recommended next action: " + result.recommended_action
        : "";

      const dataNeeded = Array.isArray(result?.data_needed) ? result.data_needed : [];
      assistantData.hidden = dataNeeded.length === 0;
      assistantData.textContent = dataNeeded.length
        ? "Narleo could be more specific with: " + dataNeeded.join(" · ")
        : "";

      const followUps = Array.isArray(result?.suggested_follow_ups)
        ? result.suggested_follow_ups
        : [];
      assistantFollowups.hidden = followUps.length === 0;
      assistantFollowups.replaceChildren();
      if (followUps.length) {
        const label = documentImpl.createElement("strong");
        label.textContent = "Try asking next";
        assistantFollowups.append(label);
        for (const suggestion of followUps) {
          const button = documentImpl.createElement("button");
          button.type = "button";
          button.className = "button secondary";
          button.style.marginTop = "7px";
          button.textContent = suggestion;
          button.addEventListener("click", () => {
            assistantQuestion.value = suggestion;
            assistantQuestion.focus();
          });
          assistantFollowups.append(button);
        }
      }
    }

    const channelEligible = featureAccess.unified_inbox === true;
    channelsCard.hidden = !channelEligible;
    if (channelEligible) {
      channelsOpen.disabled = view.channels?.loading === true;
      channelsOpen.textContent = view.channels?.loading ? "Opening secure setup…" : "Manage customer channels";
      channelsError.hidden = !view.channels?.error;
      channelsError.textContent = view.channels?.error || "";
    }

    const facebookEligible = featureAccess.automated_publishing === true;
    facebookCard.hidden = !facebookEligible;
    if (facebookEligible) {
      const connectionState = view.facebook?.status?.state
        || (view.facebook?.loading ? "Checking…" : "Not Connected");
      const connected = connectionState === "Connected";
      facebookState.textContent = connectionState;
      facebookDetail.textContent = view.facebook?.status?.account?.page_name
        || view.facebook?.status?.action
        || "Connect this business's own Facebook Page before publishing.";
      facebookError.hidden = !view.facebook?.error;
      facebookError.textContent = view.facebook?.error || "";
      facebookConnect.hidden = connected;
      facebookConnect.disabled = view.facebook?.loading === true || view.channels?.loading === true;
      facebookConnect.textContent = connectionState === "Needs Attention"
        ? "Reconnect Facebook"
        : "Connect Facebook";
      facebookRefresh.disabled = view.facebook?.loading === true || view.facebook?.publishing === true;
      facebookRefresh.textContent = view.facebook?.loading === true ? "Checking…" : "Refresh connection";
      facebookForm.hidden = !connected;
      facebookPublish.disabled = view.facebook?.publishing === true;
      facebookPublish.textContent = view.facebook?.publishing === true
        ? "Publishing…"
        : "Publish reviewed post";
      facebookPublishStatus.hidden = !view.facebook?.publishError;
      facebookPublishStatus.textContent = view.facebook?.publishError || "";
      facebookResult.hidden = !view.facebook?.result;
      if (view.facebook?.result) {
        const type = view.facebook.result.post_type === "photo"
          ? "photo post"
          : view.facebook.result.post_type === "multi_photo"
            ? "multi-photo post"
            : "post";
        facebookResult.textContent = "Published to "
          + (view.facebook.result.page_name || "Facebook")
          + " · "
          + type
          + ".";
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

  emailSigninForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(emailSigninForm);
    await controller.requestEmailSignIn(data.get("email"));
  });

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
  squareSkip?.addEventListener("click", () => controller.skipSquare());
  channelsOpen?.addEventListener("click", () => controller.openConnectorSetup());
  function updateFirstWinTaskUI() {
    const social = firstWinTask?.value !== "customer_reply";
    const businessType = controller.getState().profile?.business_type || "other";
    const examples = {
      retail: {
        social: "Example: Feature a new fall hat display and invite customers to stop in.",
        reply: "Example: Do you have this style in black and what is the price?",
        assistant: "Example: What should I promote this week?",
      },
      bakery_food: {
        social: "Example: Fall royal icing cookies are available for seasonal orders.",
        reply: "Example: Can I order 30 cookies for Saturday and what will it cost?",
        assistant: "Example: Which seasonal item should I promote next?",
      },
      auto_dealer: {
        social: "Example: Feature a 2021 Honda Accord Sport that just arrived.",
        reply: "Example: Is the Accord still available and can I come see it Saturday?",
        assistant: "Example: Which vehicles should I feature more heavily this week?",
      },
      service: {
        social: "Example: We have a few appointment openings next week for new customers.",
        reply: "Example: Do you have an opening Friday and how does scheduling work?",
        assistant: "Example: How can I turn more inquiries into booked appointments?",
      },
      other: {
        social: "Example: Promote one product, service, event, or offer you want customers to notice.",
        reply: "Example: Paste a real customer question you want help answering.",
        assistant: "Example: What should I focus on this week to grow the business?",
      },
    };
    const example = examples[businessType] || examples.other;
    firstWinImageField.hidden = !social;
    firstWinPromptLabel.textContent = social ? "What are you promoting?" : "What did the customer ask?";
    firstWinPrompt.placeholder = social ? example.social : example.reply;
    if (assistantQuestion && !assistantQuestion.value) assistantQuestion.placeholder = example.assistant;
    if (!social) {
      firstWinImageDataUrl = "";
      if (firstWinImage) firstWinImage.value = "";
      if (firstWinPreview) {
        firstWinPreview.src = "";
        firstWinPreview.hidden = true;
      }
    }
  }

  firstWinTask?.addEventListener("change", updateFirstWinTaskUI);
  updateFirstWinTaskUI();

  firstWinImage?.addEventListener("change", () => {
    const file = firstWinImage.files?.[0];
    firstWinImageDataUrl = "";
    firstWinPreview.src = "";
    firstWinPreview.hidden = true;
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      firstWinStatus.hidden = false;
      firstWinStatus.textContent = "Choose a JPG or PNG photo under 5 MB.";
      firstWinImage.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      firstWinImageDataUrl = String(reader.result || "");
      firstWinPreview.src = firstWinImageDataUrl;
      firstWinPreview.hidden = !firstWinImageDataUrl;
      firstWinStatus.hidden = true;
      firstWinStatus.textContent = "";
    };
    reader.readAsDataURL(file);
  });

  assistantForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(assistantForm);
    const question = String(data.get("question") || "").trim();
    const ok = await controller.askNarleo(question);
    if (ok && assistantQuestion) assistantQuestion.value = "";
  });

  firstWinCopy?.addEventListener("click", async () => {
    const text = String(controller.getState().firstWin?.result?.primary_text || "");
    if (!text) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      firstWinCopy.textContent = "Copied";
    } catch {
      firstWinStatus.hidden = false;
      firstWinStatus.textContent = "Copy is not available in this browser. Select the text above to copy it.";
    }
  });

  firstWinCopySecondary?.addEventListener("click", async () => {
    const text = String(controller.getState().firstWin?.result?.secondary_text || "");
    if (!text) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
      firstWinCopySecondary.textContent = "Copied";
    } catch {
      firstWinStatus.hidden = false;
      firstWinStatus.textContent = "Copy is not available in this browser. Select the Instagram text above to copy it.";
    }
  });

  firstWinUseFacebook?.addEventListener("click", () => {
    const result = controller.getState().firstWin?.result;
    if (result?.task !== "social_post" || !result.primary_text) return;
    if (facebookMessage) facebookMessage.value = result.primary_text;
    if (firstWinImageDataUrl) {
      facebookImageDataUrl = firstWinImageDataUrl;
      if (facebookPreview) {
        facebookPreview.src = firstWinImageDataUrl;
        facebookPreview.hidden = false;
      }
    }
    if (facebookReviewed) facebookReviewed.checked = false;
    facebookCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    if (controller.getState().facebook?.status?.state !== "Connected") {
      facebookPublishStatus.hidden = false;
      facebookPublishStatus.textContent = "Your draft is ready here. Connect Facebook before publishing.";
    } else {
      facebookPublishStatus.hidden = true;
      facebookPublishStatus.textContent = "";
      facebookMessage?.focus?.();
    }
  });

  firstWinForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(firstWinForm);
    await controller.createFirstWin({
      task: data.get("task"),
      prompt: data.get("prompt"),
      imageDataUrl: firstWinImageDataUrl,
    });
  });

  facebookConnect?.addEventListener("click", () => controller.openConnectorSetup());
  facebookRefresh?.addEventListener("click", () => controller.refreshFacebookStatus());

  facebookImage?.addEventListener("change", () => {
    const file = facebookImage.files?.[0];
    facebookImageDataUrl = "";
    facebookPreview.src = "";
    facebookPreview.hidden = true;
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type) || file.size > 5 * 1024 * 1024) {
      facebookPublishStatus.hidden = false;
      facebookPublishStatus.textContent = "Choose a JPG or PNG photo under 5 MB.";
      facebookImage.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      facebookImageDataUrl = String(reader.result || "");
      facebookPreview.src = facebookImageDataUrl;
      facebookPreview.hidden = !facebookImageDataUrl;
      facebookPublishStatus.hidden = true;
      facebookPublishStatus.textContent = "";
    };
    reader.readAsDataURL(file);
  });

  facebookForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(facebookForm);
    if (facebookReviewed?.checked !== true) {
      facebookPublishStatus.hidden = false;
      facebookPublishStatus.textContent = "Review the copy and photo, then confirm before publishing.";
      return;
    }
    const ok = await controller.publishFacebook({
      message: data.get("message"),
      imageDataUrl: facebookImageDataUrl,
      reviewed: true,
    });
    if (ok && facebookReviewed) facebookReviewed.checked = false;
  });
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
    if (action === "first-win") {
      firstWinCard?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      firstWinPrompt?.focus?.();
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
  signOut?.addEventListener("click", async () => { await controller.signOut(); });
  controller.restore();
  return controller;
}

if (typeof document !== "undefined") mountTenantWorkspace();
