const ENDPOINT = "/.netlify/functions";
const INSTAGRAM_ORIGIN = "https://www.instagram.com";
const MICROSOFT_LOGIN_ORIGIN = "https://login.microsoftonline.com";
const FACEBOOK_ORIGIN = "https://www.facebook.com";
const INVITATION_PATTERN = /^gw_inv_[A-Za-z0-9_-]{43}$/;
const INSTAGRAM_STATES = new Set(["Not Connected", "Connected", "Needs Attention"]);
const EMAIL_STATES = new Set(["Not Connected", "Connected", "Needs Attention"]);
const FACEBOOK_STATES = new Set(["Not Connected", "Connected", "Needs Attention"]);
const WEBSITE_STATES = new Set(["Not Connected", "Connected"]);
const WEBSITE_FORM_PATTERN = /^#form=gwf_[A-Za-z0-9_-]{22}$/;
const FACEBOOK_RETURN_HINTS = new Set(["connected", "cancelled", "attention", "select", "no-page"]);
const FACEBOOK_SELECTION_PATTERN = /^gw_fbsel_[A-Za-z0-9_-]{43}$/;

function safePath(url) { return `${url.pathname}${url.search}`; }

export function normalizeWebsiteFormUrl(value, origin = globalThis.location?.origin) {
  try {
    const target = new URL(String(value || ""), origin);
    if (!origin || target.origin !== origin || target.pathname !== "/website-contact.html"
      || target.search || !WEBSITE_FORM_PATTERN.test(target.hash)) return "";
    return target.toString();
  } catch {
    return "";
  }
}

export async function bootstrapConnectorInvitation({
  href = globalThis.location.href,
  historyImpl = globalThis.history,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(href, globalThis.location?.origin);
  if (!url.hash) return { exchanged: false, attempted: false };
  const rawFragment = url.hash.slice(1);
  const params = new URLSearchParams(rawFragment);
  const values = params.getAll("invite");
  const token = params.size === 1 && values.length === 1 ? values[0] : null;

  // Remove the secret-bearing fragment before any request or navigation.
  url.hash = "";
  historyImpl.replaceState(null, "", safePath(url));

  if (!token || !INVITATION_PATTERN.test(token)) {
    return { exchanged: false, attempted: true, error: "Invitation is invalid or expired." };
  }

  let response;
  try {
    response = await fetchImpl(`${ENDPOINT}/connector-invitation-exchange`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invitation_token: token }),
    });
  } catch {
    return { exchanged: false, attempted: true, error: "Invitation could not be verified." };
  }
  if (!response.ok) {
    return { exchanged: false, attempted: true, error: "Invitation is invalid or expired." };
  }
  return { exchanged: true, attempted: true };
}

export function connectorInvitationAllowsPageStart(result = {}) {
  return result?.attempted !== true || result?.exchanged === true;
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

export function consumeFacebookReturnHint({ href = globalThis.location.href, historyImpl = globalThis.history } = {}) {
  const url = new URL(href, globalThis.location?.origin);
  const hint = url.searchParams.get("facebook");
  if (hint !== null) {
    url.searchParams.delete("facebook");
    historyImpl.replaceState(null, "", safePath(url));
  }
  return FACEBOOK_RETURN_HINTS.has(hint)
    ? hint : null;
}

export function consumeFacebookSelectionToken({
  href = globalThis.location.href,
  historyImpl = globalThis.history,
} = {}) {
  const url = new URL(href, globalThis.location?.origin);
  if (!url.hash) return null;
  const facebookHints = url.searchParams.getAll("facebook");
  if (url.hash === "#_=_" && url.searchParams.size === 1 && facebookHints.length === 1
    && FACEBOOK_RETURN_HINTS.has(facebookHints[0])) {
    url.hash = "";
    historyImpl.replaceState(null, "", safePath(url));
    return null;
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const values = params.getAll("facebook_selection");
  if (params.size !== 1 || values.length !== 1 || !FACEBOOK_SELECTION_PATTERN.test(values[0])) {
    return null;
  }
  url.hash = "";
  historyImpl.replaceState(null, "", safePath(url));
  return values[0];
}

export function createCustomerConnectorController({
  fetchImpl = globalThis.fetch,
  navigate = (url) => globalThis.location.assign(url),
  origin = globalThis.location?.origin,
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
    facebook: {
      state: "Setup unavailable",
      action: "Facebook Page connection is not available yet.",
      account: null,
      available: false,
      allowed: false,
      connecting: false,
      disconnecting: false,
      selectionToken: "",
      pageOptions: [],
      selecting: false,
    },
    website: {
      state: "Not Connected",
      action: "Create a hosted contact form link for this business.",
      available: false,
      allowed: false,
      working: false,
      formUrl: "",
    },
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
      const facebookAllowed = session.connectors?.facebook?.allowed === true;
      const facebookAvailable = facebookAllowed && session.connectors?.facebook?.available === true;
      let facebook = {
        state: facebookAvailable ? "Not Connected" : "Setup unavailable",
        action: facebookAvailable
          ? "Connect the Facebook Page used by this business."
          : "Facebook Page connection is not available yet.",
        account: null,
        available: facebookAvailable,
        allowed: facebookAllowed,
        connecting: false,
        disconnecting: false,
        selectionToken: "",
        pageOptions: [],
        selecting: false,
      };
      if (facebookAvailable) {
        const healthResponse = await fetchImpl(`${ENDPOINT}/facebook-connection?business_id=${encodeURIComponent(session.business_id)}`, {
          method: "GET", credentials: "same-origin", cache: "no-store",
        });
        const health = await healthResponse.json();
        if (!healthResponse.ok || health.business_id !== session.business_id || !FACEBOOK_STATES.has(health.state)) {
          throw new Error("facebook_health_failed");
        }
        facebook = {
          ...facebook,
          state: health.state,
          action: typeof health.action === "string" ? health.action : "",
          account: health.state === "Connected" && typeof health.account?.page_name === "string"
            ? { pageName: health.account.page_name } : null,
        };
      }

      const websiteAllowed = session.connectors?.website?.allowed === true;
      const websiteAvailable = websiteAllowed && session.connectors?.website?.available === true;
      let website = {
        state: websiteAvailable ? "Not Connected" : "Setup unavailable",
        action: websiteAvailable
          ? "Create a hosted contact form link for this business."
          : "Website inquiry forms are not available for this session.",
        available: websiteAvailable,
        allowed: websiteAllowed,
        working: false,
        formUrl: "",
      };
      if (websiteAvailable) {
        const formResponse = await fetchImpl(`${ENDPOINT}/website-form-config`, {
          method: "GET", credentials: "same-origin", cache: "no-store",
        });
        const form = await formResponse.json();
        if (!formResponse.ok || form.business_id !== session.business_id || !WEBSITE_STATES.has(form.state)) {
          throw new Error("website_form_status_failed");
        }
        website = {
          ...website,
          state: form.state,
          action: typeof form.action === "string" ? form.action : "",
          formUrl: form.state === "Connected"
            ? normalizeWebsiteFormUrl(form.form_url, origin) : "",
        };
        if (form.state === "Connected" && !website.formUrl) throw new Error("website_form_url_invalid");
      }

      return publish({
        businessId: session.business_id,
        businessName: session.business_name,
        loading: false,
        instagram,
        email,
        facebook,
        website,
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

  function connectFacebook() {
    if (!state.businessId || !state.facebook.allowed || !state.facebook.available || state.facebook.connecting) {
      return Promise.resolve(false);
    }
    publish({ facebook: { ...state.facebook, connecting: true } });
    return (async () => {
      try {
        const response = await fetchImpl(`${ENDPOINT}/facebook-oauth-start`, {
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
        if (target.protocol !== "https:" || target.origin !== FACEBOOK_ORIGIN
          || target.username || target.password || target.hash) {
          throw new Error("unsafe_authorization_url");
        }
        navigate(target.toString());
        return true;
      } catch {
        publish({
          facebook: {
            ...state.facebook,
            state: "Needs Attention",
            connecting: false,
            action: "Facebook connection could not be started.",
          },
        });
        return false;
      }
    })();
  }

  async function loadFacebookPageOptions(selectionToken) {
    if (!state.businessId || !state.facebook.allowed || !state.facebook.available
      || !FACEBOOK_SELECTION_PATTERN.test(String(selectionToken || ""))) return false;
    try {
      const response = await fetchImpl(`${ENDPOINT}/facebook-page-options`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selection_token: selectionToken }),
      });
      const body = await response.json();
      if (!response.ok || body?.business_id !== state.businessId
        || !Array.isArray(body?.pages) || body.pages.length < 2
        || body.pages.some((page) => typeof page?.id !== "string" || typeof page?.name !== "string")) {
        throw new Error("selection_failed");
      }
      publish({
        facebook: {
          ...state.facebook,
          state: "Choose Page",
          action: "Choose the Facebook Page that belongs to this business.",
          selectionToken,
          pageOptions: body.pages.map((page) => ({ id: page.id, name: page.name })),
          selecting: false,
        },
      });
      return true;
    } catch {
      publish({
        facebook: {
          ...state.facebook,
          state: "Needs Attention",
          action: "Facebook Page selection expired. Start the Facebook connection again.",
          selectionToken: "",
          pageOptions: [],
          selecting: false,
        },
      });
      return false;
    }
  }

  async function selectFacebookPage(pageId) {
    const selected = String(pageId || "");
    if (!state.businessId || !state.facebook.selectionToken
      || !state.facebook.pageOptions.some((page) => page.id === selected)
      || state.facebook.selecting) return false;
    publish({ facebook: { ...state.facebook, selecting: true } });
    try {
      const response = await fetchImpl(`${ENDPOINT}/facebook-page-select`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: selected,
          selection_token: state.facebook.selectionToken,
        }),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true || body?.business_id !== state.businessId
        || typeof body?.account?.page_name !== "string") {
        throw new Error("selection_failed");
      }
      publish({
        facebook: {
          ...state.facebook,
          state: "Connected",
          action: "",
          account: { pageName: body.account.page_name },
          selectionToken: "",
          pageOptions: [],
          selecting: false,
        },
      });
      return true;
    } catch {
      publish({
        facebook: {
          ...state.facebook,
          state: "Needs Attention",
          action: "That Facebook Page could not be connected. Start the Facebook connection again.",
          selectionToken: "",
          pageOptions: [],
          selecting: false,
        },
      });
      return false;
    }
  }

  async function disconnectFacebook() {
    if (!state.businessId || !state.facebook.allowed || !state.facebook.available
      || !["Connected", "Needs Attention"].includes(state.facebook.state)
      || state.facebook.disconnecting) return false;
    publish({ facebook: { ...state.facebook, disconnecting: true } });
    try {
      const response = await fetchImpl(`${ENDPOINT}/facebook-disconnect`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ business_id: state.businessId }),
      });
      const body = await response.json();
      if (!response.ok || body?.ok !== true) throw new Error("disconnect_failed");
      publish({
        facebook: {
          ...state.facebook,
          state: "Not Connected",
          action: "Connect the Facebook Page used by this business.",
          account: null,
          disconnecting: false,
        },
      });
      return true;
    } catch {
      publish({
        facebook: {
          ...state.facebook,
          disconnecting: false,
          action: "Facebook could not be disconnected.",
        },
      });
      return false;
    }
  }

  async function createWebsiteForm() {
    if (!state.businessId || !state.website.allowed || !state.website.available || state.website.working) return false;
    publish({ website: { ...state.website, working: true } });
    try {
      const response = await fetchImpl(`${ENDPOINT}/website-form-config`, {
        method: "POST",
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => ({}));
      const formUrl = normalizeWebsiteFormUrl(body?.form_url, origin);
      if (!response.ok || body?.ok !== true || body.business_id !== state.businessId
        || body.state !== "Connected" || !formUrl) throw new Error("website_form_create_failed");
      publish({
        website: {
          ...state.website,
          state: "Connected",
          action: typeof body.action === "string" ? body.action : "",
          working: false,
          formUrl,
        },
      });
      return true;
    } catch {
      publish({
        website: {
          ...state.website,
          working: false,
          action: "Website form could not be created right now.",
        },
      });
      return false;
    }
  }

  async function disconnectWebsiteForm() {
    if (!state.businessId || !state.website.allowed || !state.website.available
      || state.website.state !== "Connected" || state.website.working) return false;
    publish({ website: { ...state.website, working: true } });
    try {
      const response = await fetchImpl(`${ENDPOINT}/website-form-config`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || body.business_id !== state.businessId
        || body.state !== "Not Connected") throw new Error("website_form_disable_failed");
      publish({
        website: {
          ...state.website,
          state: "Not Connected",
          action: "Create a hosted contact form link for this business.",
          working: false,
          formUrl: "",
        },
      });
      return true;
    } catch {
      publish({
        website: {
          ...state.website,
          working: false,
          action: "Website form could not be disabled right now.",
        },
      });
      return false;
    }
  }

  return {
    load,
    createWebsiteForm,
    disconnectWebsiteForm,
    connectInstagram,
    connectEmail,
    disconnectEmail,
    connectFacebook,
    disconnectFacebook,
    loadFacebookPageOptions,
    selectFacebookPage,
    setEmailMailboxContext,
    getState: () => structuredClone(state),
  };
}

export function createConnectorInboxController({
  fetchImpl = globalThis.fetch,
  onChange = () => {},
} = {}) {
  let state = { loading: true, error: "", businessId: null, sources: [], leads: [] };
  const publish = (next) => {
    state = { ...state, ...next };
    onChange(structuredClone(state));
    return structuredClone(state);
  };

  async function load() {
    publish({ loading: true, error: "" });
    try {
      const response = await fetchImpl(`${ENDPOINT}/connector-inbox`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok
        || typeof body?.business_id !== "string"
        || !Array.isArray(body?.sources)
        || !Array.isArray(body?.leads)) {
        throw new Error("inbox_unavailable");
      }
      return publish({
        loading: false,
        error: "",
        businessId: body.business_id,
        sources: body.sources,
        leads: body.leads,
      });
    } catch {
      return publish({
        loading: false,
        error: "Recent messages are unavailable because this secure session is invalid, expired, or cannot access an inbox channel.",
        businessId: null,
        sources: [],
        leads: [],
      });
    }
  }

  return { load, getState: () => structuredClone(state) };
}

function formatConnectorInboxTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function mountConnectorInbox({ documentImpl = globalThis.document, fetchImpl = globalThis.fetch } = {}) {
  const status = documentImpl.getElementById("connector-inbox-status");
  const list = documentImpl.getElementById("connector-inbox-list");
  if (!status || !list) return null;

  const render = (view) => {
    list.replaceChildren();

    if (view.loading) {
      status.textContent = "Checking secure inbox…";
      return;
    }
    if (view.error) {
      status.textContent = view.error;
      return;
    }

    status.textContent = view.leads.length
      ? `${view.leads.length} recent message${view.leads.length === 1 ? "" : "s"} from the channel${view.sources.length === 1 ? "" : "s"} allowed by this secure session.`
      : "No recent messages were found for the channels allowed by this secure session.";

    for (const lead of view.leads) {
      const article = documentImpl.createElement("article");
      article.className = "inbox-message";

      const top = documentImpl.createElement("div");
      top.className = "inbox-message-top";

      const sender = documentImpl.createElement("strong");
      sender.textContent = lead.customer_name || lead.customer_contact || "Customer";

      const badge = documentImpl.createElement("span");
      badge.className = "inbox-source";
      badge.textContent = lead.source || lead.source_type || "Message";

      top.append(sender, badge);

      const message = documentImpl.createElement("p");
      message.textContent = String(lead.message || "").slice(0, 600);

      const meta = documentImpl.createElement("small");
      const received = formatConnectorInboxTime(lead.received_at || lead.created_at);
      meta.textContent = [lead.customer_contact, received].filter(Boolean).join(" · ");

      article.append(top, message, meta);
      list.append(article);
    }
  };

  const controller = createConnectorInboxController({ fetchImpl, onChange: render });
  render(controller.getState());
  controller.load().then(() => {
    if (facebookSelectionToken) controller.loadFacebookPageOptions(facebookSelectionToken);
  });
  return controller;
}

export function mountCustomerConnectorPage({
  documentImpl = globalThis.document,
  facebookSelectionToken = "",
} = {}) {
  const businessName = documentImpl.getElementById("business-name");
  const error = documentImpl.getElementById("connection-error");
  const instagramCard = documentImpl.getElementById("instagram-card");
  const instagramStatus = documentImpl.getElementById("instagram-status");
  const instagramDetail = documentImpl.getElementById("instagram-detail");
  const instagramButton = documentImpl.getElementById("instagram-connect");
  const emailCard = documentImpl.getElementById("email-card");
  const emailStatus = documentImpl.getElementById("email-status");
  const emailDetail = documentImpl.getElementById("email-detail");
  const emailButton = documentImpl.getElementById("email-connect");
  const emailUnavailable = documentImpl.getElementById("email-unavailable");
  const emailDisconnect = documentImpl.getElementById("email-disconnect");
  const emailChoices = [...documentImpl.querySelectorAll('input[name="email-mailbox-context"]')];
  const facebookCard = documentImpl.getElementById("facebook-card");
  const facebookStatus = documentImpl.getElementById("facebook-status");
  const facebookDetail = documentImpl.getElementById("facebook-detail");
  const facebookButton = documentImpl.getElementById("facebook-connect");
  const facebookUnavailable = documentImpl.getElementById("facebook-unavailable");
  const facebookDisconnect = documentImpl.getElementById("facebook-disconnect");
  const facebookPicker = documentImpl.getElementById("facebook-page-picker");
  const facebookChoice = documentImpl.getElementById("facebook-page-choice");
  const facebookConfirm = documentImpl.getElementById("facebook-page-confirm");
  const websiteCard = documentImpl.getElementById("website-card");
  const websiteStatus = documentImpl.getElementById("website-status");
  const websiteDetail = documentImpl.getElementById("website-detail");
  const websiteCreate = documentImpl.getElementById("website-create");
  const websiteDisconnect = documentImpl.getElementById("website-disconnect");
  const websiteLinkPanel = documentImpl.getElementById("website-link-panel");
  const websiteFormLink = documentImpl.getElementById("website-form-link");
  const websiteCopy = documentImpl.getElementById("website-copy");
  const websiteOpen = documentImpl.getElementById("website-open");
  const websiteCopyStatus = documentImpl.getElementById("website-copy-status");
  const render = (view) => {
    businessName.textContent = view.businessName;
    error.textContent = view.error;
    instagramCard.hidden = !view.loading && !view.instagram.allowed;
    instagramStatus.textContent = view.loading ? "Checking…" : view.instagram.state;
    instagramDetail.textContent = view.instagram.account
      ? `Connected to @${view.instagram.account.username}` : view.instagram.action;
    instagramButton.hidden = !view.instagram.allowed;
    instagramButton.disabled = view.loading || view.instagram.connecting;
    instagramButton.textContent = view.instagram.connecting ? "Connecting…"
      : view.instagram.state === "Not Connected" ? "Connect Instagram" : "Reconnect Instagram";
    emailCard.hidden = !view.loading && !view.email.available;
    emailStatus.textContent = view.loading ? "Checking…" : view.email.state;
    emailDetail.textContent = view.email.account
      ? `Connected to ${view.email.account.address}`
      : view.email.action;
    emailUnavailable.hidden = view.email.available;
    emailButton.hidden = !view.email.available || view.email.state === "Connected";
    emailButton.disabled = view.loading || view.email.connecting || !view.email.mailboxContext;
    emailButton.textContent = view.email.connecting ? "Connecting…"
      : view.email.state === "Not Connected" ? "Connect Microsoft Email" : "Reconnect Microsoft Email";
    emailDisconnect.hidden = !view.email.available || !["Connected", "Needs Attention"].includes(view.email.state);
    emailDisconnect.disabled = view.loading || view.email.disconnecting;
    emailDisconnect.textContent = view.email.disconnecting ? "Disconnecting…" : "Disconnect";
    for (const choice of emailChoices) {
      choice.checked = choice.value === view.email.mailboxContext;
      choice.disabled = view.loading || !view.email.allowed || view.email.state === "Connected";
    }
    facebookCard.hidden = !view.loading && !view.facebook.available;
    facebookStatus.textContent = view.loading ? "Checking…" : view.facebook.state;
    facebookDetail.textContent = view.facebook.account
      ? `Connected to ${view.facebook.account.pageName}`
      : view.facebook.action;
    facebookUnavailable.hidden = view.facebook.available;
    facebookButton.hidden = !view.facebook.available || view.facebook.state === "Connected";
    facebookButton.disabled = view.loading || view.facebook.connecting;
    facebookButton.textContent = view.facebook.connecting ? "Connecting…"
      : view.facebook.state === "Not Connected" ? "Connect Facebook" : "Reconnect Facebook";
    facebookDisconnect.hidden = !view.facebook.available
      || !["Connected", "Needs Attention"].includes(view.facebook.state);
    facebookDisconnect.disabled = view.loading || view.facebook.disconnecting;
    facebookDisconnect.textContent = view.facebook.disconnecting ? "Disconnecting…" : "Disconnect";
    const showPicker = view.facebook.state === "Choose Page" && view.facebook.pageOptions.length > 1;
    facebookPicker.hidden = !showPicker;
    if (showPicker) {
      const current = facebookChoice.value;
      facebookChoice.replaceChildren();
      for (const page of view.facebook.pageOptions) {
        const option = documentImpl.createElement("option");
        option.value = page.id;
        option.textContent = page.name;
        facebookChoice.append(option);
      }
      if (view.facebook.pageOptions.some((page) => page.id === current)) facebookChoice.value = current;
      facebookConfirm.disabled = view.facebook.selecting;
      facebookConfirm.textContent = view.facebook.selecting ? "Connecting…" : "Use this Page";
    }

    websiteCard.hidden = !view.loading && !view.website.available;
    websiteStatus.textContent = view.loading ? "Checking…" : view.website.state;
    websiteDetail.textContent = view.website.action;
    websiteCreate.hidden = !view.website.available || view.website.state === "Connected";
    websiteCreate.disabled = view.loading || view.website.working;
    websiteCreate.textContent = view.website.working ? "Creating…" : "Create website form";
    websiteDisconnect.hidden = !view.website.available || view.website.state !== "Connected";
    websiteDisconnect.disabled = view.loading || view.website.working;
    websiteLinkPanel.hidden = view.website.state !== "Connected" || !view.website.formUrl;
    websiteFormLink.value = view.website.formUrl || "";
    websiteOpen.disabled = !view.website.formUrl;
    websiteCopy.disabled = !view.website.formUrl;
  };
  const controller = createCustomerConnectorController({ onChange: render });
  instagramButton.addEventListener("click", () => controller.connectInstagram());
  emailButton.addEventListener("click", () => controller.connectEmail());
  emailDisconnect.addEventListener("click", () => controller.disconnectEmail());
  facebookButton.addEventListener("click", () => controller.connectFacebook());
  facebookDisconnect.addEventListener("click", () => controller.disconnectFacebook());
  facebookConfirm.addEventListener("click", () => controller.selectFacebookPage(facebookChoice.value));
  websiteCreate.addEventListener("click", () => controller.createWebsiteForm());
  websiteDisconnect.addEventListener("click", () => controller.disconnectWebsiteForm());
  websiteCopy.addEventListener("click", async () => {
    const value = controller.getState().website.formUrl || "";
    if (!value) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(value);
      websiteCopyStatus.textContent = "Link copied.";
    } catch {
      websiteCopyStatus.textContent = "Copy is unavailable in this browser. Select the link above to copy it.";
    }
  });
  websiteOpen.addEventListener("click", () => {
    const value = controller.getState().website.formUrl || "";
    if (value) globalThis.open?.(value, "_blank", "noopener,noreferrer");
  });
  for (const choice of emailChoices) {
    choice.addEventListener("change", () => controller.setEmailMailboxContext(choice.value));
  }
  render(controller.getState());
  controller.load();
  return controller;
}

async function startBrowserPage() {
  const facebookSelectionToken = consumeFacebookSelectionToken();
  const invitation = await bootstrapConnectorInvitation();
  if (!connectorInvitationAllowsPageStart(invitation)) {
    const error = globalThis.document?.getElementById("connection-error");
    if (error) error.textContent = invitation.error || "Invitation is invalid or expired.";
    return;
  }
  consumeInstagramReturnHint();
  consumeEmailReturnHint();
  const facebookHint = consumeFacebookReturnHint();
  if (facebookHint === "no-page") {
    const error = globalThis.document?.getElementById("connection-error");
    if (error) error.textContent = "No manageable Facebook Page was found for that Facebook account.";
  }
  mountCustomerConnectorPage({ facebookSelectionToken });
  mountConnectorInbox();
}

if (typeof document !== "undefined") startBrowserPage();
