function safeError(code, cause) {
  const error = new Error(code);
  if (cause) error.cause = cause;
  return error;
}

async function netlifyPool() {
  const { getDatabase } = await import("@netlify/database");
  return getDatabase().pool;
}

function cleanText(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function toDateOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw safeError("INVALID_ORDER");
  return date;
}

function moneyCents(value, { required = false } = {}) {
  if ((value === null || value === undefined || value === "") && !required) return 0;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw safeError("INVALID_ORDER");
  return Math.round(number);
}

function validateLine(line) {
  const itemName = cleanText(line?.itemName ?? line?.item_name, 240);
  const quantityOrdered = Number(line?.quantityOrdered ?? line?.quantity_ordered);
  const unitCostCents = Number(line?.unitCostCents ?? line?.unit_cost_cents);
  const retailPriceRaw = line?.retailPriceCents ?? line?.retail_price_cents;
  const retailPriceCents =
    retailPriceRaw === null || retailPriceRaw === undefined || retailPriceRaw === ""
      ? null
      : Number(retailPriceRaw);

  if (!itemName || !Number.isInteger(quantityOrdered) || quantityOrdered <= 0
      || !Number.isInteger(unitCostCents) || unitCostCents < 0
      || (retailPriceCents !== null && (!Number.isInteger(retailPriceCents) || retailPriceCents < 0))) {
    throw safeError("INVALID_ORDER");
  }

  return {
    id: cleanText(line?.id, 120),
    squareItemId: cleanText(line?.squareItemId ?? line?.square_item_id, 160) || null,
    squareVariationId: cleanText(line?.squareVariationId ?? line?.square_variation_id, 160) || null,
    itemName,
    variationName: cleanText(line?.variationName ?? line?.variation_name, 160) || null,
    sku: cleanText(line?.sku, 120) || null,
    upc: cleanText(line?.upc, 80) || null,
    vendorSku: cleanText(line?.vendorSku ?? line?.vendor_sku, 120) || null,
    quantityOrdered,
    unitCostCents,
    retailPriceCents,
  };
}

function validateCreate(input) {
  const businessId = cleanText(input?.businessId, 120);
  const id = cleanText(input?.id, 120);
  const poNumber = cleanText(input?.poNumber, 120);
  const vendorName = cleanText(input?.vendorName, 240);
  const lines = Array.isArray(input?.lines) ? input.lines.map(validateLine) : [];

  if (!businessId || !id || !poNumber || !vendorName || !lines.length || lines.length > 100) {
    throw safeError("INVALID_ORDER");
  }

  return {
    businessId,
    id,
    poNumber,
    vendorName,
    vendorContact: cleanText(input?.vendorContact, 500) || null,
    status: "draft",
    expectedAt: toDateOrNull(input?.expectedAt),
    carrier: cleanText(input?.carrier, 100) || null,
    trackingNumber: cleanText(input?.trackingNumber, 180) || null,
    notes: cleanText(input?.notes, 4000) || null,
    shippingCents: moneyCents(input?.shippingCents),
    taxCents: moneyCents(input?.taxCents),
    lines,
  };
}

const ALLOWED_STATUS = new Set(["draft","ordered","confirmed","shipped","received","cancelled"]);
const TRANSITIONS = {
  draft: new Set(["draft","ordered","cancelled"]),
  ordered: new Set(["ordered","confirmed","shipped","received","cancelled"]),
  confirmed: new Set(["confirmed","shipped","received","cancelled"]),
  shipped: new Set(["shipped","received","cancelled"]),
  received: new Set(["received"]),
  cancelled: new Set(["cancelled"]),
};

export function createRetailOrdersStore({ getPool = netlifyPool } = {}) {
  async function listOrders({ businessId, limit = 50 } = {}) {
    const safeBusinessId = cleanText(businessId, 120);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    if (!safeBusinessId) throw safeError("INVALID_ORDER");

    const pool = await getPool();
    const ordersResult = await pool.query(
      `SELECT id, business_id, po_number, vendor_name, vendor_contact, status,
              ordered_at, expected_at, received_at, carrier, tracking_number, notes,
              subtotal_cents, shipping_cents, tax_cents, total_cents, created_at, updated_at
         FROM retail_purchase_orders
        WHERE business_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [safeBusinessId, safeLimit],
    );

    const ids = ordersResult.rows.map((row) => row.id);
    if (!ids.length) return [];

    const linesResult = await pool.query(
      `SELECT id, purchase_order_id, square_item_id, square_variation_id, item_name,
              variation_name, sku, upc, vendor_sku, quantity_ordered, quantity_received,
              unit_cost_cents, retail_price_cents, created_at
         FROM retail_purchase_order_lines
        WHERE purchase_order_id = ANY($1::text[])
        ORDER BY created_at ASC`,
      [ids],
    );

    const byOrder = new Map();
    for (const line of linesResult.rows) {
      if (!byOrder.has(line.purchase_order_id)) byOrder.set(line.purchase_order_id, []);
      byOrder.get(line.purchase_order_id).push(line);
    }

    return ordersResult.rows.map((order) => ({
      ...order,
      lines: byOrder.get(order.id) || [],
    }));
  }

  async function getOrder({ businessId, id } = {}) {
    const safeBusinessId = cleanText(businessId, 120);
    const safeId = cleanText(id, 120);
    if (!safeBusinessId || !safeId) throw safeError("INVALID_ORDER");

    const pool = await getPool();
    const orderResult = await pool.query(
      `SELECT id, business_id, po_number, vendor_name, vendor_contact, status,
              ordered_at, expected_at, received_at, carrier, tracking_number, notes,
              subtotal_cents, shipping_cents, tax_cents, total_cents, created_at, updated_at
         FROM retail_purchase_orders
        WHERE id = $1 AND business_id = $2`,
      [safeId, safeBusinessId],
    );
    const order = orderResult.rows[0];
    if (!order) return null;

    const linesResult = await pool.query(
      `SELECT id, purchase_order_id, square_item_id, square_variation_id, item_name,
              variation_name, sku, upc, vendor_sku, quantity_ordered, quantity_received,
              unit_cost_cents, retail_price_cents, created_at
         FROM retail_purchase_order_lines
        WHERE purchase_order_id = $1
        ORDER BY created_at ASC`,
      [safeId],
    );
    return { ...order, lines: linesResult.rows };
  }

  async function createOrder(input) {
    const value = validateCreate(input);
    const subtotalCents = value.lines.reduce(
      (sum, line) => sum + (line.unitCostCents * line.quantityOrdered), 0,
    );
    const totalCents = subtotalCents + value.shippingCents + value.taxCents;

    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const order = await client.query(
        `INSERT INTO retail_purchase_orders
          (id, business_id, po_number, vendor_name, vendor_contact, status, expected_at,
           carrier, tracking_number, notes, subtotal_cents, shipping_cents, tax_cents, total_cents)
         VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [
          value.id, value.businessId, value.poNumber, value.vendorName, value.vendorContact,
          value.expectedAt, value.carrier, value.trackingNumber, value.notes,
          subtotalCents, value.shippingCents, value.taxCents, totalCents,
        ],
      );

      const insertedLines = [];
      for (const [index, line] of value.lines.entries()) {
        const lineId = line.id || `${value.id}-line-${index + 1}`;
        const result = await client.query(
          `INSERT INTO retail_purchase_order_lines
            (id, purchase_order_id, square_item_id, square_variation_id, item_name,
             variation_name, sku, upc, vendor_sku, quantity_ordered, quantity_received,
             unit_cost_cents, retail_price_cents)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12)
           RETURNING *`,
          [
            lineId, value.id, line.squareItemId, line.squareVariationId, line.itemName,
            line.variationName, line.sku, line.upc, line.vendorSku, line.quantityOrdered,
            line.unitCostCents, line.retailPriceCents,
          ],
        );
        insertedLines.push(result.rows[0]);
      }

      await client.query("COMMIT");
      return { ...order.rows[0], lines: insertedLines };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (error?.code === "23505") throw safeError("ORDER_ALREADY_EXISTS", error);
      throw safeError("ORDER_CREATE_FAILED", error);
    } finally {
      client.release();
    }
  }

  async function updateOrder({
    businessId,
    id,
    status,
    expectedAt,
    carrier,
    trackingNumber,
    notes,
    receivedQuantities,
    now = new Date(),
  } = {}) {
    const safeBusinessId = cleanText(businessId, 120);
    const safeId = cleanText(id, 120);
    if (!safeBusinessId || !safeId || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw safeError("INVALID_ORDER");
    }

    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const currentResult = await client.query(
        "SELECT * FROM retail_purchase_orders WHERE id = $1 AND business_id = $2 FOR UPDATE",
        [safeId, safeBusinessId],
      );
      const current = currentResult.rows[0];
      if (!current) throw safeError("ORDER_NOT_FOUND");

      const nextStatus = status === undefined ? current.status : cleanText(status, 40);
      if (!ALLOWED_STATUS.has(nextStatus) || !TRANSITIONS[current.status]?.has(nextStatus)) {
        throw safeError("INVALID_ORDER_STATUS");
      }

      const nextExpectedAt = expectedAt === undefined ? current.expected_at : toDateOrNull(expectedAt);
      const nextCarrier = carrier === undefined ? current.carrier : (cleanText(carrier, 100) || null);
      const nextTracking = trackingNumber === undefined ? current.tracking_number : (cleanText(trackingNumber, 180) || null);
      const nextNotes = notes === undefined ? current.notes : (cleanText(notes, 4000) || null);

      if (receivedQuantities && typeof receivedQuantities === "object") {
        const lineRows = await client.query(
          "SELECT id, quantity_ordered, quantity_received FROM retail_purchase_order_lines WHERE purchase_order_id = $1 FOR UPDATE",
          [safeId],
        );
        for (const line of lineRows.rows) {
          if (!Object.prototype.hasOwnProperty.call(receivedQuantities, line.id)) continue;
          const quantity = Number(receivedQuantities[line.id]);
          if (!Number.isInteger(quantity) || quantity < 0 || quantity > Number(line.quantity_ordered)) {
            throw safeError("INVALID_RECEIVED_QUANTITY");
          }
          await client.query(
            "UPDATE retail_purchase_order_lines SET quantity_received = $2 WHERE id = $1",
            [line.id, quantity],
          );
        }
      }

      if (nextStatus === "received") {
        await client.query(
          "UPDATE retail_purchase_order_lines SET quantity_received = quantity_ordered WHERE purchase_order_id = $1",
          [safeId],
        );
      }

      const updated = await client.query(
        `UPDATE retail_purchase_orders
            SET status = $3,
                ordered_at = CASE WHEN $3 <> 'draft' AND ordered_at IS NULL THEN $4 ELSE ordered_at END,
                received_at = CASE WHEN $3 = 'received' THEN COALESCE(received_at, $4) ELSE received_at END,
                expected_at = $5,
                carrier = $6,
                tracking_number = $7,
                notes = $8,
                updated_at = $4
          WHERE id = $1 AND business_id = $2
          RETURNING *`,
        [safeId, safeBusinessId, nextStatus, now, nextExpectedAt, nextCarrier, nextTracking, nextNotes],
      );

      const lines = await client.query(
        "SELECT * FROM retail_purchase_order_lines WHERE purchase_order_id = $1 ORDER BY created_at ASC",
        [safeId],
      );
      await client.query("COMMIT");
      return { ...updated.rows[0], lines: lines.rows };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      if (["ORDER_NOT_FOUND","INVALID_ORDER_STATUS","INVALID_RECEIVED_QUANTITY","INVALID_ORDER"].includes(error?.message)) {
        throw error;
      }
      throw safeError("ORDER_UPDATE_FAILED", error);
    } finally {
      client.release();
    }
  }

  return { listOrders, getOrder, createOrder, updateOrder };
}
