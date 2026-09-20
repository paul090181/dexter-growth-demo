const DEFAULT_ENDPOINT_BASE = "/.netlify/functions";
const DEFAULT_AUTHORIZATION_ORIGIN = "https://www.instagram.com";
const STATES = new Set(["Not Connected", "Connected", "Needs Attention"]);
const HINTS = new Set(["connected", "cancelled", "attention"]);

export function createInstagramConnectionController({
  businessId,
  endpointBase = DEFAULT_ENDPOINT_BASE,
  authorizationOrigin = DEFAULT_AUTHORIZATION_ORIGIN,
  adminKey,
  fetchImpl = globalThis.fetch,
  navigate = (url) => globalThis.location.assign(url),
  historyImpl = globalThis.history,
  onChange = () => {},
}) {
  if (typeof businessId !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId)) {
    throw new TypeError("A valid businessId is required.");
  }
  let view = { state: "Not Connected", loading: true, connecting: false, account: null, action: "Checking Instagram connection…" };
  let connectPromise = null;
  const publish = (change) => { view = { ...view, ...change }; onChange({ ...view }); return { ...view }; };
  const adminKeyValue = () => {
    const value = typeof adminKey === "function" ? adminKey() : adminKey;
    return typeof value === "string" ? value.trim() : "";
  };
  const headers = () => ({ "X-GrowthWise-Key": adminKeyValue() });
  const lockedView = () => publish({
    state: "Not Connected",
    account: null,
    action: "Enter your GrowthWise access key above to connect Instagram.",
    loading: false,
    connecting: false,
  });

  async function loadHealth() {
    if (!adminKeyValue()) return lockedView();
    publish({ loading: true });
    try {
      const url = `${endpointBase}/instagram-connection?business_id=${encodeURIComponent(businessId)}`;
      const response = await fetchImpl(url, { method: "GET", headers: headers(), cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !STATES.has(body?.state)) throw new Error("health_failed");
      const account = body.state === "Connected" && body.account && typeof body.account.username === "string"
        ? { username: body.account.username } : null;
      return publish({ state: body.state, account, action: typeof body.action === "string" ? body.action : "", loading: false });
    } catch {
      return publish({ state: "Needs Attention", account: null, action: "GrowthWise could not check Instagram right now.", loading: false });
    }
  }

  function connect() {
    if (connectPromise) return connectPromise;
    if (!adminKeyValue()) return Promise.resolve(lockedView() && false);
    publish({ connecting: true });
    connectPromise = (async () => {
      try {
        const response = await fetchImpl(`${endpointBase}/instagram-oauth-start`, {
          method: "POST", headers: { ...headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ business_id: businessId }),
        });
        const body = await response.json();
        if (!response.ok) {
          const error = new Error("start_failed");
          error.status = response.status;
          throw error;
        }
        if (!body || Object.keys(body).length !== 1 || typeof body.authorization_url !== "string") throw new Error("start_failed");
        const target = new URL(body.authorization_url);
        if (target.protocol !== "https:" || target.origin !== authorizationOrigin) throw new Error("unsafe_authorization_url");
        navigate(target.toString());
        return true;
      } catch (error) {
        const action = error?.status === 401
          ? "Unlock GrowthWise with your access key above, then try again."
          : error?.status === 429
            ? "Please wait about 30 seconds, then try connecting Instagram again."
            : "Instagram connection could not be started.";
        publish({ state: "Needs Attention", account: null, action, connecting: false });
        return false;
      } finally {
        connectPromise = null;
      }
    })();
    return connectPromise;
  }

  async function consumeReturnHint(value = globalThis.location.href) {
    const url = new URL(value, globalThis.location?.origin);
    const hint = url.searchParams.get("instagram");
    if (hint !== null) {
      url.searchParams.delete("instagram");
      historyImpl.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
    await loadHealth();
    return HINTS.has(hint) ? hint : null;
  }
  return { loadHealth, connect, consumeReturnHint, getView: () => ({ ...view }) };
}

export function mountInstagramConnection({ root, businessId, getAdminKey, ...options }) {
  if (!root?.ownerDocument) throw new TypeError("A DOM root is required.");
  const document = root.ownerDocument;
  const status = document.createElement("strong");
  const detail = document.createElement("p");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  root.replaceChildren(status, detail, button);
  const render = (view) => {
    status.textContent = view.loading ? "Checking Instagram…" : view.state;
    detail.textContent = view.state === "Connected" && view.account
      ? `Connected to @${view.account.username}` : view.action;
    button.textContent = view.connecting ? "Connecting…" : view.state === "Not Connected" ? "Connect Instagram" : "Reconnect Instagram";
    button.disabled = view.connecting;
  };
  const controller = createInstagramConnectionController({ ...options, businessId, adminKey: getAdminKey, onChange: render });
  button.addEventListener("click", () => controller.connect());
  render(controller.getView());
  controller.consumeReturnHint(globalThis.location.href);
  globalThis.addEventListener?.("growthwise:admin-key-ready", () => controller.loadHealth());
  return controller;
}
