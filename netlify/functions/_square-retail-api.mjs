import { SQUARE_API_VERSION } from "./_square-oauth.mjs";

const BASES = Object.freeze({
  sandbox: "https://connect.squareupsandbox.com",
  production: "https://connect.squareup.com",
});

function base(environment) {
  const value = BASES[environment];
  if (!value) throw new Error("INVALID_SQUARE_ENVIRONMENT");
  return value;
}

async function squareRequest(path, {
  accessToken,
  environment,
  method = "GET",
  body = null,
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(`${base(environment)}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      "Square-Version": SQUARE_API_VERSION,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("SQUARE_REQUEST_FAILED");
    error.httpStatus = response.status;
    throw error;
  }
  return data;
}

async function activeLocation(options) {
  const data = await squareRequest("/v2/locations", options);
  const location = (data.locations || []).find(
    (candidate) => !candidate.status || candidate.status === "ACTIVE",
  );
  if (!location?.id) throw new Error("SQUARE_LOCATION_UNAVAILABLE");
  return location;
}

async function catalogItems(options, locationId) {
  const items = [];
  let cursor;
  do {
    const body = {
      limit: 100,
      sort_order: "ASC",
      product_types: ["REGULAR"],
      enabled_location_ids: [locationId],
      archived_state: "ARCHIVED_STATE_NOT_ARCHIVED",
      ...(cursor ? { cursor } : {}),
    };
    const data = await squareRequest("/v2/catalog/search-catalog-items", {
      ...options,
      method: "POST",
      body,
    });
    items.push(...(data.items || []));
    cursor = data.cursor;
  } while (cursor);
  return items;
}

async function inventoryCounts(options, variationIds, locationId) {
  const counts = new Map();
  for (let offset = 0; offset < variationIds.length; offset += 1000) {
    const chunk = variationIds.slice(offset, offset + 1000);
    if (!chunk.length) continue;
    let cursor;
    do {
      const body = {
        catalog_object_ids: chunk,
        location_ids: [locationId],
        states: ["IN_STOCK"],
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      };
      const data = await squareRequest("/v2/inventory/counts/batch-retrieve", {
        ...options,
        method: "POST",
        body,
      });
      for (const count of data.counts || []) {
        if (count.catalog_object_id
          && count.location_id === locationId
          && count.state === "IN_STOCK") {
          counts.set(count.catalog_object_id, {
            quantity: Number(count.quantity || 0),
            calculated_at: count.calculated_at || null,
          });
        }
      }
      cursor = data.cursor;
    } while (cursor);
  }
  return counts;
}

export async function readSquareInventory(options = {}) {
  const location = await activeLocation(options);
  const items = await catalogItems(options, location.id);
  const variationIds = items.flatMap(
    (item) => (item.item_data?.variations || []).map((variation) => variation.id).filter(Boolean),
  );
  const counts = await inventoryCounts(options, variationIds, location.id);

  const products = [];
  for (const item of items) {
    const itemData = item.item_data || {};
    for (const variation of itemData.variations || []) {
      const variationData = variation.item_variation_data || {};
      const money = variationData.price_money || {};
      const inventory = counts.get(variation.id) || {
        quantity: 0,
        calculated_at: null,
      };
      const priceCents = typeof money.amount === "number" ? money.amount : null;
      products.push({
        item_id: item.id,
        item_name: itemData.name || "Unnamed item",
        description: itemData.description_plaintext || itemData.description || "",
        variation_id: variation.id,
        variation_name: variationData.name || "Default",
        sku: variationData.sku || null,
        upc: variationData.upc || null,
        price_cents: priceCents,
        price: priceCents === null ? null : (priceCents / 100).toFixed(2),
        currency: money.currency || null,
        track_inventory: Boolean(variationData.track_inventory),
        quantity: inventory.quantity,
        inventory_calculated_at: inventory.calculated_at,
        updated_at: variation.updated_at || item.updated_at || null,
      });
    }
  }

  products.sort((a, b) => a.item_name.localeCompare(b.item_name, undefined, {
    sensitivity: "base",
  }));

  const totalUnits = products.reduce(
    (sum, product) => sum + (Number(product.quantity) || 0),
    0,
  );
  const inventoryValueCents = products.reduce((sum, product) => {
    if (product.price_cents === null) return sum;
    return sum + product.price_cents * (Number(product.quantity) || 0);
  }, 0);

  return {
    location: { id: location.id, name: location.name || null },
    summary: {
      item_count: items.length,
      variation_count: products.length,
      total_units_in_stock: totalUnits,
      inventory_value_cents: inventoryValueCents,
      inventory_value: (inventoryValueCents / 100).toFixed(2),
    },
    products,
  };
}

function toIsoDaysAgo(days, now) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString();
}

function moneyAmount(money) {
  return Number(money?.amount || 0);
}

export async function readSquareSales({
  accessToken,
  environment,
  days = 30,
  now = new Date(),
  fetchImpl = fetch,
} = {}) {
  const location = await activeLocation({ accessToken, environment, fetchImpl });
  const orders = [];
  let cursor;

  do {
    const body = {
      location_ids: [location.id],
      limit: 1000,
      return_entries: false,
      query: {
        filter: {
          date_time_filter: {
            created_at: {
              start_at: toIsoDaysAgo(days, now),
              end_at: now.toISOString(),
            },
          },
        },
        sort: { sort_field: "CREATED_AT", sort_order: "DESC" },
      },
      ...(cursor ? { cursor } : {}),
    };
    const data = await squareRequest("/v2/orders/search", {
      accessToken,
      environment,
      fetchImpl,
      method: "POST",
      body,
    });
    orders.push(...(data.orders || []));
    cursor = data.cursor;
  } while (cursor);

  const completed = orders.filter((order) => order.state === "COMPLETED");
  let grossSalesCents = 0;
  let netSalesCents = 0;
  let taxCents = 0;
  let discountCents = 0;
  let totalCollectedCents = 0;
  const productMap = new Map();

  for (const order of completed) {
    grossSalesCents += moneyAmount(order.total_money);
    taxCents += moneyAmount(order.total_tax_money);
    discountCents += moneyAmount(order.total_discount_money);
    totalCollectedCents += moneyAmount(order.net_amounts?.total_money);
    netSalesCents += moneyAmount(order.total_money) - moneyAmount(order.total_tax_money);

    for (const line of order.line_items || []) {
      const key = line.catalog_object_id
        || `${line.name || "Unknown item"}::${line.variation_name || ""}`;
      const current = productMap.get(key) || {
        catalog_object_id: line.catalog_object_id || null,
        item_name: line.name || "Unknown item",
        variation_name: line.variation_name || null,
        quantity_sold: 0,
        gross_sales_cents: 0,
        total_collected_cents: 0,
        discount_cents: 0,
      };
      current.quantity_sold += Number(line.quantity || 0);
      current.gross_sales_cents += moneyAmount(line.gross_sales_money);
      current.total_collected_cents += moneyAmount(line.total_money);
      current.discount_cents += moneyAmount(line.total_discount_money);
      productMap.set(key, current);
    }
  }

  const products = [...productMap.values()]
    .map((product) => ({
      ...product,
      gross_sales: (product.gross_sales_cents / 100).toFixed(2),
      total_collected: (product.total_collected_cents / 100).toFixed(2),
      discount: (product.discount_cents / 100).toFixed(2),
    }))
    .sort((a, b) => b.total_collected_cents - a.total_collected_cents);

  const recentOrders = completed.slice(0, 20).map((order) => ({
    id: order.id,
    created_at: order.created_at || null,
    closed_at: order.closed_at || null,
    state: order.state,
    total_cents: moneyAmount(order.total_money),
    total: (moneyAmount(order.total_money) / 100).toFixed(2),
    currency: order.total_money?.currency || "USD",
    line_item_count: (order.line_items || []).length,
    customer_id: order.customer_id || null,
  }));

  const averageOrderCents = completed.length
    ? Math.round(totalCollectedCents / completed.length)
    : 0;

  return {
    period_days: days,
    location: { id: location.id, name: location.name || null },
    summary: {
      completed_order_count: completed.length,
      gross_sales_cents: grossSalesCents,
      gross_sales: (grossSalesCents / 100).toFixed(2),
      net_sales_cents: netSalesCents,
      net_sales: (netSalesCents / 100).toFixed(2),
      tax_cents: taxCents,
      tax: (taxCents / 100).toFixed(2),
      discount_cents: discountCents,
      discount: (discountCents / 100).toFixed(2),
      total_collected_cents: totalCollectedCents,
      total_collected: (totalCollectedCents / 100).toFixed(2),
      average_order_cents: averageOrderCents,
      average_order: (averageOrderCents / 100).toFixed(2),
    },
    top_products: products.slice(0, 25),
    recent_orders: recentOrders,
  };
}
