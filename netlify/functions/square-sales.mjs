const SQUARE_BASE = "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2026-08-19";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function square(path, token, options = {}) {
  const response = await fetch(`${SQUARE_BASE}${path}`, {
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
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: response.status,
        data: { raw: text },
      };
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
  };
}

function moneyAmount(money) {
  return Number(money?.amount || 0);
}

function toIsoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

async function getOrders(token, locationId, days) {
  const orders = [];
  let cursor;

  do {
    const body = {
      location_ids: [locationId],
      limit: 1000,
      return_entries: false,
      query: {
        filter: {
          date_time_filter: {
            created_at: {
              start_at: toIsoDaysAgo(days),
              end_at: new Date().toISOString(),
            },
          },
        },
        sort: {
          sort_field: "CREATED_AT",
          sort_order: "DESC",
        },
      },
    };

    if (cursor) body.cursor = cursor;

    const result = await square("/v2/orders/search", token, {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!result.ok) {
      return {
        ok: false,
        status: result.status,
        data: result.data,
      };
    }

    orders.push(...(result.data.orders || []));
    cursor = result.data.cursor;
  } while (cursor);

  return {
    ok: true,
    orders,
  };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "X-GrowthWise-Key",
      },
    });
  }

  if (request.method !== "GET") {
    return json(405, { error: "Method not allowed" });
  }

  const token = Netlify.env.get("SQUARE_SANDBOX_TOKEN");
  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");

  if (!token || !adminKey) {
    return json(500, {
      error: "Server configuration is incomplete.",
    });
  }

  const suppliedKey = request.headers.get("x-growthwise-key") || "";

  if (suppliedKey !== adminKey) {
    return json(401, {
      error: "Invalid GrowthWise admin key.",
    });
  }

  const url = new URL(request.url);
  const requestedDays = Number(url.searchParams.get("days") || 30);
  const days =
    Number.isFinite(requestedDays) && requestedDays >= 1
      ? Math.min(Math.floor(requestedDays), 365)
      : 30;

  // 1) Find the active Square location.
  const locations = await square("/v2/locations", token, {
    method: "GET",
  });

  if (!locations.ok) {
    return json(locations.status, {
      error: "Could not read Square locations.",
      square: locations.data,
    });
  }

  const location = (locations.data.locations || []).find(
    (loc) => !loc.status || loc.status === "ACTIVE"
  );

  if (!location) {
    return json(400, {
      error: "No active Square location was found.",
    });
  }

  // 2) Pull orders from Square.
  const orderResult = await getOrders(token, location.id, days);

  if (!orderResult.ok) {
    return json(orderResult.status, {
      error: "Could not read Square orders.",
      square: orderResult.data,
    });
  }

  const completedOrders = orderResult.orders.filter(
    (order) => order.state === "COMPLETED"
  );

  let grossSalesCents = 0;
  let netSalesCents = 0;
  let taxCents = 0;
  let discountCents = 0;
  let totalCollectedCents = 0;

  const productMap = new Map();

  for (const order of completedOrders) {
    grossSalesCents += moneyAmount(order.total_money);
    taxCents += moneyAmount(order.total_tax_money);
    discountCents += moneyAmount(order.total_discount_money);
    totalCollectedCents += moneyAmount(order.net_amounts?.total_money);

    // Approximate net sales before tax using the completed order totals.
    netSalesCents +=
      moneyAmount(order.total_money) - moneyAmount(order.total_tax_money);

    for (const line of order.line_items || []) {
      const key =
        line.catalog_object_id ||
        `${line.name || "Unknown item"}::${line.variation_name || ""}`;

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

  const recentOrders = completedOrders.slice(0, 20).map((order) => ({
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

  const averageOrderCents =
    completedOrders.length > 0
      ? Math.round(totalCollectedCents / completedOrders.length)
      : 0;

  return json(200, {
    ok: true,
    source: "Square Sandbox",
    square_api_version: SQUARE_VERSION,
    generated_at: new Date().toISOString(),
    period_days: days,
    location: {
      id: location.id,
      name: location.name || null,
    },
    summary: {
      completed_order_count: completedOrders.length,
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
  });
};
