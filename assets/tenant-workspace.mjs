const PROFILE_ENDPOINT = "/.netlify/functions/tenant-profile";
const STATUS_ENDPOINT = "/.netlify/functions/subscription-status";
const PORTAL_ENDPOINT = "/.netlify/functions/stripe-customer-portal";
const PLAN_CHANGE_ENDPOINT = "/.netlify/functions/stripe-plan-change";
const LEAD_ENDPOINT = "/.netlify/functions/retail-lead-assistant";
const SQUARE_CONNECTION_ENDPOINT = "/.netlify/functions/square-connection";
const SQUARE_OAUTH_START_ENDPOINT = "/.netlify/functions/square-oauth-start";

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
} = {}) {
  let state = {
    loading: false,
    signedIn: false,
    error: "",
    profile: null,
    subscription: null,
    square: { enabled: false, loading: false, error: "", status: null },
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

      if (persist) saveWorkspaceCredentials({ businessId: id, tenantKey: key }, storage);
      return publish({
        loading: false,
        signedIn: true,
        error: "",
        profile,
        subscription,
        square,
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
      });
    }
  }

  async function restore() {
    const credentials = readWorkspaceCredentials(storage);
    if (!credentials.businessId || !credentials.tenantKey) return publish({ loading: false, signedIn: false, error: "" });
    return authenticate({ ...credentials, persist: false });
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
      lead: { loading: false, error: "", result: null },
    });
  }

  return {
    authenticate,
    restore,
    openBilling,
    changePlan,
    connectSquare,
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

  const controller = createTenantWorkspaceController({ onChange: render });
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
