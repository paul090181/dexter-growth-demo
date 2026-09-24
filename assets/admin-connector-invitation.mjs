const ENDPOINT = "/.netlify/functions/connector-invitation-create";
const STORAGE_KEY = "growthwise_admin_key";
const BUSINESS_ID = "growthwise-dev";
const CONNECTORS = Object.freeze(["email"]);
const INVITE_FRAGMENT = /^#invite=gw_inv_[A-Za-z0-9_-]{43}$/;

function sameOriginInvitation(value, origin) {
  const target = new URL(value, origin);
  if (target.origin !== origin
    || target.pathname !== "/connect-accounts.html"
    || target.search
    || !INVITE_FRAGMENT.test(target.hash)
    || target.username
    || target.password) {
    throw new Error("unsafe_invitation_url");
  }
  return target;
}

export function createGrowthWiseDevEmailInvitationController({
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
  origin = globalThis.location?.origin,
  navigate = (url) => globalThis.location.assign(url),
  onState = () => {},
} = {}) {
  if (typeof fetchImpl !== "function" || !storage || typeof origin !== "string" || !origin) {
    throw new TypeError("Invalid invitation controller configuration.");
  }

  function hasAdminKey() {
    return Boolean((storage.getItem(STORAGE_KEY) || "").trim());
  }

  async function createAndOpen() {
    const adminKey = (storage.getItem(STORAGE_KEY) || "").trim();
    if (!adminKey) {
      onState({ status: "locked", message: "Unlock GrowthWise first." });
      return false;
    }

    onState({ status: "loading", message: "Creating secure email invitation…" });

    let response;
    try {
      response = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-GrowthWise-Key": adminKey,
        },
        body: JSON.stringify({
          business_id: BUSINESS_ID,
          connectors: [...CONNECTORS],
        }),
      });
    } catch {
      onState({ status: "error", message: "Invitation service could not be reached." });
      return false;
    }

    const body = await response.json().catch(() => ({}));

    if (response.status === 401) {
      storage.removeItem(STORAGE_KEY);
      onState({ status: "locked", message: "GrowthWise admin session expired. Unlock again." });
      return false;
    }

    if (!response.ok
      || body?.business_id !== BUSINESS_ID
      || !Array.isArray(body?.connectors)
      || body.connectors.length !== 1
      || body.connectors[0] !== "email"
      || typeof body?.invitation_url !== "string") {
      onState({ status: "error", message: "Secure invitation could not be created." });
      return false;
    }

    let target;
    try {
      target = sameOriginInvitation(body.invitation_url, origin);
    } catch {
      onState({ status: "error", message: "Invitation response was rejected." });
      return false;
    }

    onState({ status: "opening", message: "Opening secure connector…" });
    navigate(target.toString());
    return true;
  }

  return { hasAdminKey, createAndOpen };
}

export function mountGrowthWiseDevEmailInvitation({
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
} = {}) {
  const card = documentImpl?.getElementById("emailAcceptanceOperator");
  const button = documentImpl?.getElementById("createEmailAcceptanceInvitationBtn");
  const status = documentImpl?.getElementById("emailAcceptanceOperatorStatus");
  if (!card || !button || !status) return null;

  function setState(state) {
    status.className = "create-status";
    if (state.status === "error" || state.status === "locked") status.classList.add("error");
    else if (state.status === "loading" || state.status === "opening") status.classList.add("loading");
    else status.classList.add("ok");
    status.textContent = state.message;
  }

  const controller = createGrowthWiseDevEmailInvitationController({
    fetchImpl: windowImpl.fetch.bind(windowImpl),
    storage: windowImpl.sessionStorage,
    origin: windowImpl.location.origin,
    navigate: (url) => windowImpl.location.assign(url),
    onState: setState,
  });

  function refreshVisibility() {
    const unlocked = controller.hasAdminKey();
    card.classList.toggle("hidden", !unlocked);
    if (!unlocked) {
      status.className = "create-status hidden";
      status.textContent = "";
    }
  }

  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await controller.createAndOpen();
    } finally {
      button.disabled = false;
      refreshVisibility();
    }
  });

  windowImpl.addEventListener("growthwise:admin-key-ready", refreshVisibility);
  refreshVisibility();
  return controller;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  mountGrowthWiseDevEmailInvitation();
}
