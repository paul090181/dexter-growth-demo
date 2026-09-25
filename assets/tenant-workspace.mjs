const PROFILE_ENDPOINT = "/.netlify/functions/tenant-profile";
const STATUS_ENDPOINT = "/.netlify/functions/subscription-status";
const PORTAL_ENDPOINT = "/.netlify/functions/stripe-customer-portal";

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
  };

  const publish = (next) => {
    state = { ...state, ...next };
    onChange(structuredClone(state));
    return structuredClone(state);
  };

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

      if (persist) saveWorkspaceCredentials({ businessId: id, tenantKey: key }, storage);
      return publish({ loading: false, signedIn: true, error: "", profile, subscription });
    } catch (error) {
      clearWorkspaceCredentials(storage);
      return publish({
        loading: false,
        signedIn: false,
        error: error?.message || "Workspace sign-in failed.",
        profile: null,
        subscription: null,
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

  function signOut() {
    clearWorkspaceCredentials(storage);
    return publish({ loading: false, signedIn: false, error: "", profile: null, subscription: null });
  }

  return {
    authenticate,
    restore,
    openBilling,
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
  const manage = documentImpl.getElementById("workspace-manage-billing");
  const signOut = documentImpl.getElementById("workspace-signout");

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
    manage.hidden = view.subscription?.access_source !== "stripe";
    manage.disabled = view.loading;
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
  signOut?.addEventListener("click", () => controller.signOut());
  controller.restore();
  return controller;
}

if (typeof document !== "undefined") mountTenantWorkspace();
