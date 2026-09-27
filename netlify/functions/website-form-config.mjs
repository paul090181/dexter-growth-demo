import { randomBytes } from "node:crypto";
import { authorizeConnectorRequest } from "./_connector-auth.mjs";
import { connectorJson } from "./_connector-http.mjs";
import { createConnectorStore } from "./_connector-store.mjs";
import { createWebsiteFormStore } from "./_website-form-store.mjs";

const PATH = "/.netlify/functions/website-form-config";

function publicFormUrl(request, formId) {
  const url = new URL(request.url);
  if (url.protocol !== "https:") throw new Error("INVALID_ORIGIN");
  const target = new URL("/website-contact.html", url.origin);
  target.hash = "form=" + formId;
  return target.toString();
}

function sameOriginMutation(request) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  return url.protocol === "https:"
    && origin === url.origin
    && (site === null || site === "same-origin");
}

function createFormId() {
  return "gwf_" + randomBytes(16).toString("base64url");
}

export function createWebsiteFormConfigHandler({
  connectorStore = createConnectorStore(),
  formStore = createWebsiteFormStore(),
  connectorAuthorize = authorizeConnectorRequest,
  now = () => new Date(),
  formIdFactory = createFormId,
} = {}) {
  return async function websiteFormConfig(request) {
    let url;
    try { url = new URL(request.url); }
    catch { return connectorJson(400, { error: "Invalid request." }); }

    if (url.pathname !== PATH || url.search || url.hash) {
      return connectorJson(400, { error: "Invalid request." });
    }
    if (!["GET", "POST", "DELETE"].includes(request.method)) {
      return connectorJson(405, { error: "Method not allowed." }, { allow: "GET, POST, DELETE" });
    }
    if (request.method !== "GET" && !sameOriginMutation(request)) {
      return connectorJson(403, { error: "Request origin was rejected." });
    }

    const auth = await connectorAuthorize(request, {
      store: connectorStore,
      connector: "website",
      now: now(),
    });
    if (!auth?.ok || !auth.businessId) {
      return connectorJson(401, { error: "Session is invalid or expired." });
    }

    if (request.method === "GET") {
      let row;
      try {
        row = await formStore.readByBusiness({ businessId: auth.businessId });
      } catch {
        return connectorJson(503, { error: "Website form status is temporarily unavailable." });
      }
      const connected = Boolean(row && !row.disabled_at);
      return connectorJson(200, {
        business_id: auth.businessId,
        state: connected ? "Connected" : "Not Connected",
        form_url: connected ? publicFormUrl(request, row.form_id) : null,
        action: connected
          ? "Website inquiries will flow into this business's Narleo inbox."
          : "Create a hosted contact form link for this business.",
      });
    }

    if (request.method === "DELETE") {
      try {
        await formStore.disable({ businessId: auth.businessId, now: now() });
      } catch {
        return connectorJson(503, { error: "Website form could not be disabled." });
      }
      return connectorJson(200, {
        ok: true,
        business_id: auth.businessId,
        state: "Not Connected",
      });
    }

    let row;
    try {
      row = await formStore.ensureEnabled({
        businessId: auth.businessId,
        formId: formIdFactory(),
        now: now(),
      });
    } catch {
      return connectorJson(503, { error: "Website form could not be created." });
    }
    return connectorJson(200, {
      ok: true,
      business_id: auth.businessId,
      state: "Connected",
      form_url: publicFormUrl(request, row.form_id),
      action: "Website inquiries will flow into this business's Narleo inbox.",
    });
  };
}

export default function handler(request) {
  return createWebsiteFormConfigHandler()(request);
}
