const EXCHANGE_ENDPOINT = "/.netlify/functions/tenant-login-exchange";

export function consumeMagicToken({
  href = globalThis.location.href,
  historyImpl = globalThis.history,
} = {}) {
  const url = new URL(href, globalThis.location?.origin);
  const raw = url.hash.startsWith("#") ? url.hash.slice(1) : "";
  const params = new URLSearchParams(raw);
  const values = params.getAll("token");
  const token = params.size === 1 && values.length === 1 ? values[0] : "";

  url.hash = "";
  historyImpl.replaceState(null, "", `${url.pathname}${url.search}`);

  return /^gw_login_[A-Za-z0-9_-]{43}$/.test(token) ? token : "";
}

export async function exchangeMagicToken({
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!/^gw_login_[A-Za-z0-9_-]{43}$/.test(String(token || ""))) {
    return { ok: false, error: "This sign-in link is invalid or expired." };
  }

  try {
    const response = await fetchImpl(EXCHANGE_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body?.ok !== true || typeof body?.business_id !== "string") {
      return { ok: false, error: body?.error || "This sign-in link is invalid or expired." };
    }
    return {
      ok: true,
      businessId: body.business_id,
    };
  } catch {
    return { ok: false, error: "Secure sign-in is temporarily unavailable." };
  }
}

export async function startMagicSignIn({
  documentImpl = globalThis.document,
  locationImpl = globalThis.location,
  historyImpl = globalThis.history,
  storage = globalThis.sessionStorage,
  fetchImpl = globalThis.fetch,
} = {}) {
  const status = documentImpl?.getElementById("signin-status");
  const fallback = documentImpl?.getElementById("signin-fallback");
  const token = consumeMagicToken({ href: locationImpl.href, historyImpl });

  if (!token) {
    if (status) {
      status.textContent = "This sign-in link is invalid or expired.";
      status.className = "status error";
    }
    if (fallback) fallback.hidden = false;
    return false;
  }

  const result = await exchangeMagicToken({ token, fetchImpl });
  if (!result.ok) {
    if (status) {
      status.textContent = result.error;
      status.className = "status error";
    }
    if (fallback) fallback.hidden = false;
    return false;
  }

  storage?.setItem("growthwise_business_id", result.businessId);
  storage?.removeItem("growthwise_tenant_key");
  locationImpl.replace("./app.html?signin=success");
  return true;
}

if (typeof document !== "undefined") startMagicSignIn();
