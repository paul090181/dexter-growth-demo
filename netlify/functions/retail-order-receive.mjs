import { createRetailOrdersStore } from "./_retail-orders-store.mjs";

const SQUARE_BASE = "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2026-09-16";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function squareRequest(fetchImpl, path, token, options = {}) {
  const response = await fetchImpl(`${SQUARE_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { raw: text }; }
  }
  return { ok: response.ok, status: response.status, data };
}

export function createRetailOrderReceiveHandler(options = {}) {
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name));
  const store = options.store ?? createRetailOrdersStore();
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  return async function handler(request) {
    if (request.method !== "POST") return json(405, { error: "Method not allowed." });

    const adminKey = env("GROWTHWISE_ADMIN_KEY");
    const token = env("SQUARE_SANDBOX_TOKEN");
    if (!adminKey || !token) return json(500, { error: "Server configuration is incomplete." });
    if ((request.headers.get("x-growthwise-key") || "") !== adminKey) {
      return json(401, { error: "Invalid GrowthWise access key." });
    }

    let body;
    try { body = await request.json(); }
    catch { return json(400, { error: "Invalid JSON body." }); }

    const businessId = String(body.business_id || "dexters-hats").trim();
    const orderId = String(body.order_id || "").trim();
    if (!businessId || !orderId) return json(400, { error: "Order is required." });

    const order = await store.getOrder({ businessId, id: orderId });
    if (!order) return json(404, { error: "Purchase order was not found." });
    if (order.status === "cancelled") return json(409, { error: "Cancelled orders cannot be received." });
    if (order.status === "received") {
      return json(200, { ok: true, already_received: true, order });
    }

    const remainingLines = (order.lines || []).map((line) => ({
      ...line,
      remaining: Math.max(0, Number(line.quantity_ordered || 0) - Number(line.quantity_received || 0)),
    })).filter((line) => line.remaining > 0);

    const missingSquareLink = remainingLines.filter((line) => !line.square_variation_id);
    if (missingSquareLink.length) {
      return json(400, {
        error: "One or more order lines are not linked to an existing Square inventory item.",
        code: "SQUARE_VARIATION_REQUIRED",
        items: missingSquareLink.map((line) => line.item_name),
      });
    }

    const locations = await squareRequest(fetchImpl, "/v2/locations", token, { method: "GET" });
    if (!locations.ok) return json(502, { error: "GrowthWise could not read the Square location." });
    const location = (locations.data.locations || []).find((loc) => !loc.status || loc.status === "ACTIVE");
    if (!location) return json(400, { error: "No active Square location was found." });

    if (remainingLines.length) {
      const occurredAt = now().toISOString();
      const changes = remainingLines.map((line) => ({
        type: "ADJUSTMENT",
        adjustment: {
          reference_id: line.id,
          catalog_object_id: line.square_variation_id,
          from_state: "NONE",
          to_state: "IN_STOCK",
          from_location_id: location.id,
          to_location_id: location.id,
          quantity: String(line.remaining),
          occurred_at: occurredAt,
          reason_id: { type: "RECEIVED" },
        },
      }));

      const result = await squareRequest(fetchImpl, "/v2/inventory/changes/batch-create", token, {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: order.id,
          changes,
          ignore_unchanged_counts: true,
        }),
      });

      if (!result.ok) {
        console.error("retail_order_square_receive_failed", {
          order_id: order.id,
          status: result.status,
          error_count: Array.isArray(result.data?.errors) ? result.data.errors.length : 0,
        });
        return json(502, {
          error: "Square did not confirm the received inventory. The GrowthWise order was not marked received.",
          code: "SQUARE_RECEIVE_FAILED",
        });
      }
    }

    const receivedQuantities = Object.fromEntries(
      (order.lines || []).map((line) => [line.id, Number(line.quantity_ordered || 0)]),
    );
    const updated = await store.updateOrder({
      businessId,
      id: order.id,
      status: "received",
      receivedQuantities,
      now: now(),
    });

    return json(200, {
      ok: true,
      already_received: false,
      square_location: { id: location.id, name: location.name || null },
      received_line_count: remainingLines.length,
      order: updated,
    });
  };
}

export default createRetailOrderReceiveHandler();
