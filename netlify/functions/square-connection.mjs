import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";
import { createSquareStore } from "./_square-store.mjs";

const PATH = "/.netlify/functions/square-connection";
const STORED_STATES = new Set(["active", "needs_attention", "revoked"]);

function json(status, body, { allow = null } = {}) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

export function createSquareConnectionHandler(options = {}) {
  const tenantStore = options.tenantStore ?? createTenantStore();
  const squareStore = options.squareStore ?? createSquareStore();
  const authorize = options.authorize ?? authorizeTenantRequest;
  const now = options.now ?? (() => new Date());

  return async function squareConnection(request) {
    if (request.method !== "GET") {
      return json(405, { error: "Method not allowed." }, { allow: "GET" });
    }

    const url = new URL(request.url);
    if (url.pathname !== PATH
      || url.hash
      || [...url.searchParams].length !== 1
      || url.searchParams.getAll("business_id").length !== 1) {
      return json(400, { error: "Invalid request." });
    }

    const businessId = url.searchParams.get("business_id");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId || "")
      || businessId.length > 80) {
      return json(400, { error: "Invalid request." });
    }

    const auth = await authorize(request, {
      businessId,
      store: tenantStore,
    });
    if (!auth?.ok || auth.businessId !== businessId) {
      return json(401, { error: "Tenant credentials are invalid." });
    }

    const checkedAt = now();
    try {
      const row = await squareStore.readCredential({ businessId });

      if (!row) {
        return json(200, {
          business_id: businessId,
          state: "Not Connected",
          checked_at: checkedAt.toISOString(),
          account: null,
          action: "Connect Square to use tenant-specific inventory and sales.",
        });
      }

      if (!STORED_STATES.has(row.status) || row.status !== "active") {
        return json(200, {
          business_id: businessId,
          state: "Needs Attention",
          checked_at: checkedAt.toISOString(),
          account: {
            display_name: row.display_name || "Square account",
          },
          action: "Reconnect Square so GrowthWise can restore tenant-specific inventory and sales.",
        });
      }

      return json(200, {
        business_id: businessId,
        state: "Connected",
        checked_at: checkedAt.toISOString(),
        account: {
          display_name: row.display_name || "Square account",
        },
        action: "",
      });
    } catch {
      return json(503, {
        error: "Square connection could not be checked.",
      });
    }
  };
}

export default createSquareConnectionHandler();
