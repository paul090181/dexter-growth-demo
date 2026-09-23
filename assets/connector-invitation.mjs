const ENDPOINT = "/.netlify/functions";
const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
const INVITATION_PATTERN = /^gw_inv_[A-Za-z0-9_-]{43}$/;
const INSTAGRAM_STATES = new Set(["Not Connected", "Connected", "Needs Attention"]);
const EMAIL_STATES = new Set(["Not Connected", "Connected", "Needs Attention"]);

function safePath(url) { return `${url.pathname}${url.search}`; }

export async function bootstrapConnectorInvitation({
  href = globalThis.location.href,
  historyImpl = globalThis.history,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(href, globalThis.location?.origin);
  if (!url.hash) return { exchanged: false };
  const rawFragment = url.hash.slice(1);
  const params = new URLSearchParams(rawFragment);
  const values = params.getAll("invite");
  const token = params.size === 1 && values.length === 1 ? values[0] : null;

  // Remove the secret-bearing fragment before any request or navigation.
  url.hash = "";
  historyImpl.replaceState(null, "", safePath(url));

  if (!token || !INVITATION_PATTERN.test(token)) return { exchanged: false };
  const response = await fetchImpl(`${ENDPOINT}/connector-invitation-exchange`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invitation_token: token }),
  });
  if (!response.ok) return { exchanged: false, error: "Invitation is invalid or expired." };
  return { exchanged: true };
}

export function consumeEmailReturnHint({ href = globalThis.location.href, historyImpl = globalThis.history } = {}) {
  const url = new URL(href, globalThis.location?.origin);
  const hint = url.searchParams.get("email");
  if (hint !== null) {
    url.searchParams.delete("email");
    historyImpl.replaceState(null, "", safePath(url));
  }
  return new Set(["connected", "cancelled", "attention"]).has(hint) ? hint : null;
}

export function consumeInstagramReturnHint({ href = globalThis.location.href, historyImpl = globalThis.history } = {}) {
  const url = new URL(href, globalThis.location?.origin);
  const hint = url.searchParams.get("instagram");
  if (hint !== null) {
    url.searchParams.delete("instagram");
    historyImpl.replaceState(null, "", safePath(url));
  }
  return new Set(["connected", "cancelled", "attention"]).has(hint) ? hint : null;
}

export function createCustomerConnectorController({
  fetchImpl = globalThis.fetch,
  navigate = (url) => globalThis.location.assign(url),
  onChange = () => {},
} = {}) {
  let state = {
    businessId: null,
    businessName: "Your business",
    loading: true,
    error: "",
    instagram: { state: "Not Connected", action: "", account: null, allowed: false, connecting: false },
    email: {
      state: "Setup unavailable",
      action: "Microsoft email connection is not available yet.",
      account: null,
      available: false,
      allowed: false,
      connecting: false,
      disconnecting: false,
      mailboxContext: "",
    },
    facebook: { state: "Setup unavailable", available: false },
  };
  let connectPromise = null;
  const publish = (change) => {
    state = { ...state, ...change };
    onChange(structuredClone(state));
    return structuredClone(state);
  };

  async function load() {
    publish({ loading: true, error: "" });
    try {
      const sessionResponse = await fetchImpl(`${ENDPOINT}/connector-session`, {
        method: "GET", credentials: "same-origin", cache: "no-store",
      });
      const session = await sessionResponse.json();
      if (!sessionResponse.ok || typeof session?.business_id !== "string" || typeof session?.business_name !== "string") {
        throw new Error("session_invalid");
      }
      const instagramAllowed = session.connectors?.instagram?.allowed === true
        && session.connectors?.instagram?.available === true;
      let instagram = { state: "Not Connected", action: "Instagram is not available for this invitation.", account: null, allowed: false, connecting: false };
      if (instagramAllowed) {
        const healthResponse = await fetchImpl(`${ENDPOINT}/instagram-connection?business_id=${encodeURIComponent(session.business_id)}`, {
          method: "GET", credentials: "same-origin", cache: "no-store",
        });
        const health = await healthResponse.json();
        if (!healthResponse.ok || health.business_id !== session.business_id || !INSTAGRAM_STATES.has(health.state)) {
          throw new Error("instagram_health_failed");
        }
        instagram = {
          state: health.state,
          action: typeof health.action === "string" ? health.action : "",
          account: health.state === "Connected" && typeof health.account?.username === "string"
            ? { username: health.account.username } : null,
          allowed: true,
          connecting: false,
        };
      }
      const emailAllowed = session.connectors?.email?.allowed === true;
      const emailAvailable = emailAllowed && session.connectors?.email?.available === true;
      let email = {
        state: emailAvailable ? "Not Connected" : "Setup unavailable",
        action: emailAvailable
          ? "Choose how this mailbox is used before connecting."
          : "Microsoft email connection is not available yet.",
        account: null,
        available: emailAvailable,
        allowed: emailAllowed,
        connecting: false,
        disconnecting: false,
        mailboxContext: "",
      };
      if (emailAvailable) {
        const healthResponse = await fetchImpl(`${ENDPOINT}/microsoft-mail-connection?business_id=${encodeURIComponent(session.business_id)}`, {
          method: "GET", credentials: "same-origin", cache: "no-store",
        });
        const health = await healthResponse.json();
        if (!healthResponse.ok || health.business_id !== session.business_id || !EMAIL_STATES.has(health.state)) {
          throw new Error("email_health_failed");
        }
        email = {
          ...email,
          state: health.state,
          action: typeof health.action === "string" ? health.action : "",
          account: health.state === "Connected" && typeof health.account?.address === "string"
            ? {
                address: health.account.address,
                displayName: health.account.display_name || health.account.address,
              }
            : null,
        };
      }
      return publish({
        businessId: session.business_id,
        businessName: session.business_name,
        loading: false,
        instagram,
        email,
        facebook: { state: "Setup unavailable", available: false },
      });
    } catch {
      return publish({ loading: false, error: "This connection session is invalid or expired." });
    }
  }

  function setEmailMailboxContext(value) {
    const allowed = new Set(["business", "personal_acknowledged"]);
    const mailboxContext = allowed.has(value) ? value : "";
    return publish({ email: { ...state.email, mailboxContext } });
  }

  function connectEmail() {
    if (!state.businessId || !state.email.allowed || !state.email.available) return Promise.resolve(false);
    if (!["business", "personal_acknowledged"].includes(state.email.mailboxContext)) {
      publish({ email: { ...state.email, action: "Choose a mailbox option before connecting." } });
      return Promise.resolve(false);
    }
    publish({ email: { ...state.email, connecting: true } });
    return (async () => {
      try {
        const response = await fetchImpl(`${ENDPOINT}/microsoft-mail-oauth-start`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ business_id: state.businessId, mailbox_context: state.email.mailboxContext }),
        });
        const body = await response.json();
        if (!response.ok || !body || Object.keys(body).length !== 1 || typeof body.authorization_url !== "string") {
          throw new Error("start_failed");
        }
        const target = new URL(body.authorization_url);
        if (target.protocol !== "https:" || target.origin !== MICROSOFT_LOGIN_ORIGIN
          || target.username || target.password || target.hash) throw new Error("unsafe_authorization_url");
        navigate(target.toString());
        return true;
      } catch {
        publish({ email: { ...state.email, state: "Needs Attention", connecting: false, action: "Microsoft email connection could not be started." } });
        return false;
      }
    })();
  }

  async function disconnectEmail() {
    if (!state.businessId
      || !state.email.allowed
      || !state.email.available
      || !["Connected", "Needs Attention"].includes(state.email.state)
      || state.email.disconnecting) return false;

    publish({ email: { ...state.email, disconnecting: true } });
    try {
      const response = await fetchImpl(`${ENDPOINT}/microsoft-mail-disconnect`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: state.businessId }),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) throw new Error("disconnect_failed");
      publish({
        email: {
          ...state.email,
          state: "Not Connected",
          action: "Choose how this mailbox is used before connecting.",
          account: null,
          disconnecting: false,
          mailboxContext: "",
        },
      });
      return true;
    } catch {
      publish({
        email: {
          ...state.email,
          disconnecting: false,
          action: "Microsoft email could not be disconnected.",
        },
      });
      return false;
    }
  }

  function connectInstagram() {
    if (connectPromise) return connectPromise;
    if (!state.businessId || !state.instagram.allowed) return Promise.resolve(false);
    publish({ instagram: { ...state.instagram, connecting: true } });
    connectPromise = (async () => {
      try {
        const response = await fetchImpl(`${ENDPOINT}/instagram-oauth-start`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ business_id: state.businessId }),
        });
        const body = await response.json();
        if (!response.ok || !body || Object.keys(body).length !== 1 || typeof body.authorization_url !== "string") {
          throw new Error("start_failed");
        }
        const target = new URL(body.authorization_url);
        if (target.protocol !== "https:" || target.origin !== INSTAGRAM_ORIGIN || target.username || target.password || target.hash) {
          throw new Error("unsafe_authorization_url");
        }
        navigate(target.toString());
        return true;
      } catch {
        publish({ instagram: { ...state.instagram, state: "Needs Attention", connecting: false, action: "Instagram connection could not be started." } });
        return false;
      } finally { connectPromise = null; }
    })();
    return connectPromise;
  }

  return {
    load,
    connectInstagram,
    connectEmail,
    disconnectEmail,
    setEmailMailboxContext,
    getState: () => structuredClone(state),
  };
}

export function mountCustomerConnectorPage({ documentImpl = globalThis.document } = {}) {
  const businessName = documentImpl.getElementById("business-name");
  const error = documentImpl.getElementById("connection-error");
  const instagramStatus = documentImpl.getElementById("instagram-status");
  const instagramDetail = documentImpl.getElementById("instagram-detail");
  const instagramButton = documentImpl.getElementById("instagram-connect");
  const emailStatus = documentImpl.getElementById("email-status");
  const emailDetail = documentImpl.getElementById("email-detail");
  const emailButton = documentImpl.getElementById("email-connect");
  const emailUnavailable = documentImpl.getElementById("email-unavailable");
  const emailDisconnect = documentImpl.getElementById("email-disconnect");
  const emailChoices = [...documentImpl.querySelectorAll('input[name="email-mailbox-context"]')];
  const render = (view) => {
    businessName.textContent = view.businessName;
    error.textContent = view.error;
    instagramStatus.textContent = view.loading ? "Checking…" : view.instagram.state;
    instagramDetail.textContent = view.instagram.account
      ? `Connected to @${view.instagram.account.username}` : view.instagram.action;
    instagramButton.hidden = !view.instagram.allowed;
    instagramButton.disabled = view.loading || view.instagram.connecting;
    instagramButton.textContent = view.instagram.connecting ? "Connecting…"
      : view.instagram.state === "Not Connected" ? "Connect Instagram" : "Reconnect Instagram";
    emailStatus.textContent = view.loading ? "Checking…" : view.email.state;
    emailDetail.textContent = view.email.account
      ? `Connected to ${view.email.account.address}`
      : view.email.action;
    emailUnavailable.hidden = view.email.available;
    emailButton.hidden = !view.email.available;
    emailButton.disabled = view.loading || view.email.connecting || !view.email.mailboxContext;
    emailButton.textContent = view.email.connecting ? "Connecting…"
      : view.email.state === "Not Connected" ? "Connect Microsoft Email" : "Reconnect Microsoft Email";
    emailDisconnect.hidden = !view.email.available || !["Connected", "Needs Attention"].includes(view.email.state);
    emailDisconnect.disabled = view.loading || view.email.disconnecting;
    emailDisconnect.textContent = view.email.disconnecting ? "Disconnecting…" : "Disconnect";
    for (const choice of emailChoices) {
      choice.disabled = view.loading || !view.email.allowed || view.email.state === "Connected";
    }
  };
  const controller = createCustomerConnectorController({ onChange: render });
  instagramButton.addEventListener("click", () => controller.connectInstagram());
  emailButton.addEventListener("click", () => controller.connectEmail());
  emailDisconnect.addEventListener("click", () => controller.disconnectEmail());
  for (const choice of emailChoices) {
    choice.addEventListener("change", () => controller.setEmailMailboxContext(choice.value));
  }
  render(controller.getState());
  controller.load();
  return controller;
}

async function startBrowserPage() {
  await bootstrapConnectorInvitation();
  consumeInstagramReturnHint();
  consumeEmailReturnHint();
  mountCustomerConnectorPage();
}

if (typeof document !== "undefined") startBrowserPage();
