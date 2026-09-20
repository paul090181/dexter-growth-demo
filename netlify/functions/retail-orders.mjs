import { createRetailOrdersStore } from "./_retail-orders-store.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function centsFromDollars(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error("INVALID_MONEY");
  return Math.round(number * 100);
}

function serializeOrder(order) {
  return {
    ...order,
    subtotal: (Number(order.subtotal_cents || 0) / 100).toFixed(2),
    shipping: (Number(order.shipping_cents || 0) / 100).toFixed(2),
    tax: (Number(order.tax_cents || 0) / 100).toFixed(2),
    total: (Number(order.total_cents || 0) / 100).toFixed(2),
    lines: (order.lines || []).map((line) => ({
      ...line,
      unit_cost: (Number(line.unit_cost_cents || 0) / 100).toFixed(2),
      retail_price:
        line.retail_price_cents === null || line.retail_price_cents === undefined
          ? null
          : (Number(line.retail_price_cents) / 100).toFixed(2),
    })),
  };
}

export function createRetailOrdersHandler(options = {}) {
  const env = options.env ?? ((name) => globalThis.Netlify?.env?.get(name));
  const store = options.store ?? createRetailOrdersStore();

  return async function handler(request) {
    if (!["GET","POST","PATCH"].includes(request.method)) return json(405, { error: "Method not allowed." });

    const adminKey = env("GROWTHWISE_ADMIN_KEY");
    if (!adminKey) return json(500, { error: "Server configuration is incomplete." });
    if ((request.headers.get("x-growthwise-key") || "") !== adminKey) {
      return json(401, { error: "Invalid GrowthWise access key." });
    }

    const url = new URL(request.url);
    const businessId = clean(url.searchParams.get("business_id") || "dexters-hats", 120);
    if (!businessId) return json(400, { error: "Business is required." });

    try {
      if (request.method === "GET") {
        const orders = await store.listOrders({ businessId, limit: 75 });
        const open = orders.filter((order) => !["received","cancelled"].includes(order.status));
        const summary = {
          order_count: orders.length,
          open_order_count: open.length,
          open_commitment_cents: open.reduce((sum, order) => sum + Number(order.total_cents || 0), 0),
          awaiting_receipt_count: orders.filter((order) => ["ordered","confirmed","shipped"].includes(order.status)).length,
          received_order_count: orders.filter((order) => order.status === "received").length,
        };
        return json(200, {
          ok: true,
          business_id: businessId,
          summary: {
            ...summary,
            open_commitment: (summary.open_commitment_cents / 100).toFixed(2),
          },
          orders: orders.map(serializeOrder),
        });
      }

      const body = await request.json();

      if (request.method === "POST") {
        const id = crypto.randomUUID();
        const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
        const poNumber = clean(body.po_number, 120) || `GW-${date}-${id.slice(0, 6).toUpperCase()}`;
        const lines = Array.isArray(body.lines) ? body.lines.map((line) => ({
          id: crypto.randomUUID(),
          squareItemId: line.square_item_id,
          squareVariationId: line.square_variation_id,
          itemName: line.item_name,
          variationName: line.variation_name,
          sku: line.sku,
          upc: line.upc,
          vendorSku: line.vendor_sku,
          quantityOrdered: Number(line.quantity_ordered),
          unitCostCents: centsFromDollars(line.unit_cost),
          retailPriceCents:
            line.retail_price === null || line.retail_price === undefined || line.retail_price === ""
              ? null
              : centsFromDollars(line.retail_price),
        })) : [];

        const order = await store.createOrder({
          id,
          businessId,
          poNumber,
          vendorName: body.vendor_name,
          vendorContact: body.vendor_contact,
          expectedAt: body.expected_at,
          notes: body.notes,
          shippingCents: centsFromDollars(body.shipping || 0) ,
          taxCents: centsFromDollars(body.tax || 0),
          lines,
        });
        return json(201, { ok: true, order: serializeOrder(order) });
      }

      const id = clean(body.id, 120);
      const order = await store.updateOrder({
        businessId,
        id,
        status: body.status,
        expectedAt: body.expected_at,
        carrier: body.carrier,
        trackingNumber: body.tracking_number,
        notes: body.notes,
        receivedQuantities: body.received_quantities,
      });
      return json(200, { ok: true, order: serializeOrder(order) });
    } catch (error) {
      const code = error?.message || "ORDER_FAILED";
      if (code === "ORDER_NOT_FOUND") return json(404, { error: "Purchase order was not found.", code });
      if (code === "ORDER_ALREADY_EXISTS") return json(409, { error: "That purchase order already exists.", code });
      if (["INVALID_ORDER","INVALID_ORDER_STATUS","INVALID_RECEIVED_QUANTITY","INVALID_MONEY"].includes(code)) {
        return json(400, { error: "Check the purchase order information and try again.", code });
      }
      console.error("retail_orders_failed", { code });
      return json(500, { error: "GrowthWise could not save the purchase order.", code: "ORDER_FAILED" });
    }
  };
}

export default createRetailOrdersHandler();
