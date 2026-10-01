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

export function createGrowthWiseDevFacebookInvitationController({
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

    onState({ status: "loading", message: "Creating secure Facebook invitation…" });

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
          connectors: ["facebook"],
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
      || body.connectors[0] !== "facebook"
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

export function mountGrowthWiseDevFacebookInvitation({
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
} = {}) {
  const card = documentImpl?.getElementById("facebookAcceptanceOperator");
  const button = documentImpl?.getElementById("createFacebookAcceptanceInvitationBtn");
  const status = documentImpl?.getElementById("facebookAcceptanceOperatorStatus");
  if (!card || !button || !status) return null;

  function setState(state) {
    status.className = "create-status";
    if (state.status === "error" || state.status === "locked") status.classList.add("error");
    else if (state.status === "loading" || state.status === "opening") status.classList.add("loading");
    else status.classList.add("ok");
    status.textContent = state.message;
  }

  const controller = createGrowthWiseDevFacebookInvitationController({
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
  mountGrowthWiseDevFacebookInvitation();
}


const DEXTER_BUSINESS_ID = "dexters-hats";
const DEXTER_PILOT_ENDPOINT = "/.netlify/functions/dexter-pilot-invitation-create";
const DEXTER_STATUS_ENDPOINT = "/.netlify/functions/dexter-pilot-status";
const DEXTER_INVITE_FRAGMENT = /^#invite=gw_pilot_inv_[A-Za-z0-9_-]{43}$/;

function sameOriginDexterPilotInvitation(value, origin) {
  const target = new URL(value, origin);
  if (target.origin !== origin
    || target.pathname !== "/dexter-pilot.html"
    || target.search
    || !DEXTER_INVITE_FRAGMENT.test(target.hash)
    || target.username
    || target.password) {
    throw new Error("unsafe_dexter_pilot_invitation_url");
  }
  return target;
}

export function createDexterPilotInvitationController({
  fetchImpl = globalThis.fetch,
  storage = globalThis.sessionStorage,
  origin = globalThis.location?.origin,
  onState = () => {},
  onActivity = () => {},
} = {}) {
  if (typeof fetchImpl !== "function" || !storage || typeof origin !== "string" || !origin) {
    throw new TypeError("Invalid Dexter pilot invitation configuration.");
  }

  function hasAdminKey() {
    return Boolean((storage.getItem(STORAGE_KEY) || "").trim());
  }

  async function createInvitation() {
    const adminKey = (storage.getItem(STORAGE_KEY) || "").trim();
    if (!adminKey) {
      onState({ status: "locked", message: "Unlock GrowthWise first." });
      return null;
    }
    onState({ status: "loading", message: "Creating Dexter's secure pilot link…" });
    let response;
    try {
      response = await fetchImpl(DEXTER_PILOT_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-GrowthWise-Key": adminKey },
        body: JSON.stringify({ business_id: DEXTER_BUSINESS_ID }),
      });
    } catch {
      onState({ status: "error", message: "Pilot invitation service could not be reached." });
      return null;
    }
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      storage.removeItem(STORAGE_KEY);
      onState({ status: "locked", message: "GrowthWise admin session expired. Unlock again." });
      return null;
    }
    if (!response.ok || body?.business_id !== DEXTER_BUSINESS_ID
      || typeof body?.invitation_url !== "string") {
      onState({ status: "error", message: "Dexter pilot link could not be created." });
      return null;
    }
    let target;
    try { target = sameOriginDexterPilotInvitation(body.invitation_url, origin); }
    catch {
      onState({ status: "error", message: "Pilot invitation response was rejected." });
      return null;
    }
    onState({
      status: "ready",
      message: "Dexter pilot link ready. It expires in 72 hours if unused; after he opens it, this device stays signed in for 30 days.",
      url: target.toString(),
    });
    return target.toString();
  }

  async function loadStatus() {
    const adminKey = (storage.getItem(STORAGE_KEY) || "").trim();
    if (!adminKey) {
      onActivity({ status: "locked", message: "Unlock GrowthWise first." });
      return null;
    }

    onActivity({ status: "loading", message: "Checking Dexter's pilot activity…" });
    let response;
    try {
      response = await fetchImpl(DEXTER_STATUS_ENDPOINT, {
        method: "GET",
        cache: "no-store",
        headers: { "X-GrowthWise-Key": adminKey },
      });
    } catch {
      onActivity({ status: "error", message: "Dexter pilot status could not be reached." });
      return null;
    }

    const body = await response.json().catch(() => ({}));
    if (response.status === 401) {
      storage.removeItem(STORAGE_KEY);
      onActivity({ status: "locked", message: "GrowthWise admin session expired. Unlock again." });
      return null;
    }

    if (!response.ok
      || body?.ok !== true
      || body?.business_id !== DEXTER_BUSINESS_ID
      || typeof body?.stage !== "string"
      || typeof body?.stage_label !== "string"
      || typeof body?.recommended_follow_up !== "string"
      || typeof body?.invitation?.state !== "string"
      || typeof body?.session?.state !== "string"
      || !body?.activity
      || !body?.feedback) {
      onActivity({ status: "error", message: "Dexter pilot status could not be loaded." });
      return null;
    }

    onActivity({
      status: "ready",
      message: body.stage_label,
      data: body,
    });
    return body;
  }

  return { hasAdminKey, createInvitation, loadStatus };
}

export function mountDexterPilotInvitation({
  documentImpl = globalThis.document,
  windowImpl = globalThis.window,
} = {}) {
  const card = documentImpl?.getElementById("dexterPilotOperator");
  const createButton = documentImpl?.getElementById("createDexterPilotInvitationBtn");
  const copyButton = documentImpl?.getElementById("copyDexterPilotInvitationBtn");
  const linkInput = documentImpl?.getElementById("dexterPilotInvitationUrl");
  const status = documentImpl?.getElementById("dexterPilotOperatorStatus");
  const activityButton = documentImpl?.getElementById("loadDexterPilotActivityBtn");
  const activityStatus = documentImpl?.getElementById("dexterPilotActivityStatus");
  const activityDetails = documentImpl?.getElementById("dexterPilotActivityDetails");
  const activityStage = documentImpl?.getElementById("dexterPilotActivityStage");
  const activityTimeline = documentImpl?.getElementById("dexterPilotActivityTimeline");
  const activityFeedback = documentImpl?.getElementById("dexterPilotActivityFeedback");
  const activityFollowUp = documentImpl?.getElementById("dexterPilotActivityFollowUp");
  if (!card || !createButton || !copyButton || !linkInput || !status
    || !activityButton || !activityStatus || !activityDetails
    || !activityStage || !activityTimeline || !activityFeedback || !activityFollowUp) return null;

  const controller = createDexterPilotInvitationController({
    fetchImpl: windowImpl.fetch.bind(windowImpl),
    storage: windowImpl.sessionStorage,
    origin: windowImpl.location.origin,
    onState(state) {
      status.className = "create-status";
      if (state.status === "error" || state.status === "locked") status.classList.add("error");
      else if (state.status === "loading") status.classList.add("loading");
      else status.classList.add("ok");
      status.textContent = state.message;
      if (state.url) {
        linkInput.value = state.url;
        linkInput.classList.remove("hidden");
        copyButton.classList.remove("hidden");
      }
    },
    onActivity(state) {
      activityStatus.className = "create-status";
      if (state.status === "error" || state.status === "locked") activityStatus.classList.add("error");
      else if (state.status === "loading") activityStatus.classList.add("loading");
      else activityStatus.classList.add("ok");
      activityStatus.textContent = state.message;

      const data = state.data;
      if (!data) {
        activityDetails.classList.add("hidden");
        return;
      }

      activityDetails.classList.remove("hidden");
      activityStage.textContent = data.stage_label;

      const formatTime = (value) => {
        if (!value) return "—";
        const parsed = new Date(value);
        return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : "—";
      };

      const eventCounts = data.activity?.counts || {};
      activityTimeline.textContent = [
        `Invite: ${String(data.invitation?.state || "unknown").replaceAll("_", " ")}`,
        `Session: ${String(data.session?.state || "unknown").replaceAll("_", " ")}`,
        `Opened: ${formatTime(data.activity?.first_opened_at)}`,
        `Last activity: ${formatTime(data.activity?.last_activity_at)}`,
        `Photo selected: ${Number(eventCounts.instagram_photo_selected || 0)}`,
        `Drafts created: ${Number(eventCounts.instagram_draft_created || 0)}`,
        `Posts completed: ${Number(eventCounts.instagram_publish_succeeded || 0)}`,
        `Publish errors: ${Number(eventCounts.instagram_publish_failed || 0)}`,
      ].join(" · ");

      activityFeedback.textContent = data.feedback?.total
        ? `Feedback: ${Number(data.feedback.worked || 0)} worked · ${Number(data.feedback.needs_improvement || 0)} needs improvement`
        : "Feedback: none yet";
      activityFollowUp.textContent = data.recommended_follow_up
        ? "Suggested follow-up: " + data.recommended_follow_up
        : "";
    },
  });

  function refreshVisibility() {
    const unlocked = controller.hasAdminKey();
    card.classList.toggle("hidden", !unlocked);
    if (!unlocked) {
      linkInput.value = "";
      linkInput.classList.add("hidden");
      copyButton.classList.add("hidden");
      status.className = "create-status hidden";
      activityStatus.className = "create-status hidden";
      activityDetails.classList.add("hidden");
      activityStage.textContent = "";
      activityTimeline.textContent = "";
      activityFeedback.textContent = "";
      activityFollowUp.textContent = "";
    }
  }

  createButton.addEventListener("click", async () => {
    createButton.disabled = true;
    try { await controller.createInvitation(); }
    finally { createButton.disabled = false; refreshVisibility(); }
  });

  copyButton.addEventListener("click", async () => {
    if (!linkInput.value) return;
    await windowImpl.navigator.clipboard.writeText(linkInput.value);
    copyButton.textContent = "Copied";
  });

  activityButton.addEventListener("click", async () => {
    activityButton.disabled = true;
    try { await controller.loadStatus(); }
    finally {
      activityButton.disabled = false;
      refreshVisibility();
    }
  });

  windowImpl.addEventListener("growthwise:admin-key-ready", refreshVisibility);
  refreshVisibility();
  return controller;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  mountDexterPilotInvitation();
}
