const FORM_ID_PATTERN = /^gwf_[A-Za-z0-9_-]{22}$/;

export function consumeWebsiteFormId({
  href = globalThis.location?.href || "",
  historyImpl = globalThis.history,
} = {}) {
  let url;
  try { url = new URL(href); } catch { return ""; }
  const params = new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
  const values = params.getAll("form");
  const formId = params.size === 1 && values.length === 1 && FORM_ID_PATTERN.test(values[0])
    ? values[0]
    : "";
  url.hash = "";
  historyImpl?.replaceState?.({}, "", url.pathname + url.search);
  return formId;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join("-");
}

export function mountWebsiteContact({
  documentImpl = globalThis.document,
  fetchImpl = globalThis.fetch,
  href = globalThis.location?.href || "",
  historyImpl = globalThis.history,
} = {}) {
  const formId = consumeWebsiteFormId({ href, historyImpl });
  const form = documentImpl.getElementById("contact-form");
  const name = documentImpl.getElementById("business-name");
  const intro = documentImpl.getElementById("intro");
  const error = documentImpl.getElementById("form-error");
  const status = documentImpl.getElementById("submit-status");
  const button = documentImpl.getElementById("submit-button");

  async function initialize() {
    if (!FORM_ID_PATTERN.test(formId)) {
      error.hidden = false;
      error.textContent = "This contact form link is invalid or no longer available.";
      return false;
    }
    try {
      const response = await fetchImpl("/.netlify/functions/website-form-info", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ form_id: formId }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true || typeof body.business_name !== "string") {
        throw new Error(body?.error || "This contact form is unavailable.");
      }
      name.textContent = "Contact " + body.business_name;
      intro.textContent = "Send a message to " + body.business_name + ".";
      form.hidden = false;
      return true;
    } catch (e) {
      error.hidden = false;
      error.textContent = e?.message || "This contact form is unavailable.";
      return false;
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const email = String(data.get("email") || "").trim();
    const phone = String(data.get("phone") || "").trim();
    if (!email && !phone) {
      status.hidden = false;
      status.className = "status error";
      status.textContent = "Add an email address or phone number so the business can reply.";
      return;
    }

    button.disabled = true;
    button.textContent = "Sending…";
    status.hidden = false;
    status.className = "status";
    status.textContent = "Sending your message…";
    try {
      const response = await fetchImpl("/.netlify/functions/website-form-submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          form_id: formId,
          submission_id: uuid(),
          name: String(data.get("name") || ""),
          email,
          phone,
          message: String(data.get("message") || ""),
          company_website: String(data.get("company_website") || ""),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.ok !== true) {
        throw new Error(body?.error || "Your message could not be sent.");
      }
      form.reset();
      status.className = "status";
      status.textContent = "Message sent. The business can follow up using the contact information you provided.";
    } catch (e) {
      status.className = "status error";
      status.textContent = e?.message || "Your message could not be sent.";
    } finally {
      button.disabled = false;
      button.textContent = "Send message";
    }
  });

  return { formId, initialize };
}

if (typeof document !== "undefined") {
  mountWebsiteContact().initialize();
}
