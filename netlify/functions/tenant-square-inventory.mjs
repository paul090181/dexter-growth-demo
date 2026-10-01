import { getSquareAccess, SquareAccessError } from "./_square-access.mjs";
import { readSquareInventory } from "./_square-retail-api.mjs";
import { authorizeTenantSquareRequest } from "./_tenant-square-auth.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function businessIdFrom(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/.netlify/functions/tenant-square-inventory"
    || url.hash
    || [...url.searchParams].length !== 1
    || url.searchParams.getAll("business_id").length !== 1) return "";
  const businessId = url.searchParams.get("business_id") || "";
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId) && businessId.length <= 80
    ? businessId
    : "";
}

function accessFailure(error) {
  if (!(error instanceof SquareAccessError)) {
    return json(503, { error: "Square inventory is temporarily unavailable." });
  }
  if (error.code === "not_connected") {
    return json(409, { error: "Connect Square before using inventory." });
  }
  if (["needs_attention", "refresh_failed"].includes(error.code)) {
    return json(409, { error: "Square connection needs attention." });
  }
  return json(503, { error: "Square inventory is temporarily unavailable." });
}

export function createTenantSquareInventoryHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantSquareRequest;
  const squareAccess = options.squareAccess ?? getSquareAccess;
  const readInventory = options.readInventory ?? readSquareInventory;

  return async function tenantSquareInventory(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });
    const businessId = businessIdFrom(request);
    if (!businessId) return json(400, { error: "Invalid request." });

    const auth = await authorize(request, { businessId });
    if (!auth?.ok) {
      const status = auth?.via === "locked" ? 403 : auth?.via === "unavailable" ? 503 : 401;
      return json(status, {
        error: status === 403
          ? "Inventory connection is not included in this plan."
          : status === 503
            ? "Business account is temporarily unavailable."
            : "Tenant credentials are invalid.",
      });
    }

    let access;
    try { access = await squareAccess({ businessId }); }
    catch (error) { return accessFailure(error); }

    try {
      const result = await readInventory({
        accessToken: access.accessToken,
        environment: access.environment,
      });
      return json(200, {
        ok: true,
        business_id: businessId,
        source: "Square",
        refreshed_token: access.refreshed === true,
        generated_at: new Date().toISOString(),
        ...result,
      });
    } catch {
      return json(503, { error: "Square inventory is temporarily unavailable." });
    }
  };
}

export default createTenantSquareInventoryHandler();
