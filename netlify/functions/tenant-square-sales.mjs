import { getSquareAccess, SquareAccessError } from "./_square-access.mjs";
import { readSquareSales } from "./_square-retail-api.mjs";
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

function requestInput(request) {
  const url = new URL(request.url);
  if (url.pathname !== "/.netlify/functions/tenant-square-sales" || url.hash) return null;
  const keys = [...url.searchParams].map(([key]) => key);
  if (keys.some((key) => !["business_id", "days"].includes(key))
    || url.searchParams.getAll("business_id").length !== 1
    || url.searchParams.getAll("days").length > 1) return null;

  const businessId = url.searchParams.get("business_id") || "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(businessId) || businessId.length > 80) {
    return null;
  }
  const rawDays = url.searchParams.get("days");
  const days = rawDays === null ? 30 : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) return null;
  return { businessId, days };
}

function accessFailure(error) {
  if (!(error instanceof SquareAccessError)) {
    return json(503, { error: "Square sales are temporarily unavailable." });
  }
  if (error.code === "not_connected") {
    return json(409, { error: "Connect Square before using sales insights." });
  }
  if (["needs_attention", "refresh_failed"].includes(error.code)) {
    return json(409, { error: "Square connection needs attention." });
  }
  return json(503, { error: "Square sales are temporarily unavailable." });
}

export function createTenantSquareSalesHandler(options = {}) {
  const authorize = options.authorize ?? authorizeTenantSquareRequest;
  const squareAccess = options.squareAccess ?? getSquareAccess;
  const readSales = options.readSales ?? readSquareSales;
  const now = options.now ?? (() => new Date());

  return async function tenantSquareSales(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });
    const input = requestInput(request);
    if (!input) return json(400, { error: "Invalid request." });

    const auth = await authorize(request, { businessId: input.businessId });
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
    try { access = await squareAccess({ businessId: input.businessId }); }
    catch (error) { return accessFailure(error); }

    try {
      const result = await readSales({
        accessToken: access.accessToken,
        environment: access.environment,
        days: input.days,
        now: now(),
      });
      return json(200, {
        ok: true,
        business_id: input.businessId,
        source: "Square",
        refreshed_token: access.refreshed === true,
        generated_at: now().toISOString(),
        ...result,
      });
    } catch {
      return json(503, { error: "Square sales are temporarily unavailable." });
    }
  };
}

export default createTenantSquareSalesHandler();
