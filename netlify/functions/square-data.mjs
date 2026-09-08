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

async function getAllCatalogItems(token, locationId) {
  const items = [];
  let cursor;

  do {
    const body = {
      limit: 100,
      sort_order: "ASC",
      product_types: ["REGULAR"],
      enabled_location_ids: [locationId],
      archived_state: "ARCHIVED_STATE_NOT_ARCHIVED",
    };

    if (cursor) body.cursor = cursor;

    const result = await square("/v2/catalog/search-catalog-items", token, {
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

    items.push(...(result.data.items || []));
    cursor = result.data.cursor;
  } while (cursor);

  return {
    ok: true,
    items,
  };
}

async function getInventoryCounts(token, variationIds, locationId) {
  const countMap = new Map();

  // Square allows up to 1,000 catalog_object_ids in one batch request.
  for (let i = 0; i < variationIds.length; i += 1000) {
    const chunk = variationIds.slice(i, i + 1000);

    if (chunk.length === 0) continue;

    let cursor;

    do {
      const body = {
        catalog_object_ids: chunk,
        location_ids: [locationId],
        states: ["IN_STOCK"],
        limit: 1000,
      };

      if (cursor) body.cursor = cursor;

      const result = await square("/v2/inventory/counts/batch-retrieve", token, {
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

      for (const count of result.data.counts || []) {
        if (
          count.catalog_object_id &&
          count.location_id === locationId &&
          count.state === "IN_STOCK"
        ) {
          countMap.set(count.catalog_object_id, {
            quantity: Number(count.quantity || 0),
            calculated_at: count.calculated_at || null,
          });
        }
      }

      cursor = result.data.cursor;
    } while (cursor);
  }

  return {
    ok: true,
    countMap,
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

  // 1) Read the seller's active Square location.
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

  // 2) Read all regular, non-archived catalog items for this location.
  const catalog = await getAllCatalogItems(token, location.id);

  if (!catalog.ok) {
    return json(catalog.status, {
      error: "Could not read the Square catalog.",
      square: catalog.data,
    });
  }

  const variationIds = [];

  for (const item of catalog.items) {
    for (const variation of item.item_data?.variations || []) {
      if (variation.id) variationIds.push(variation.id);
    }
  }

  // 3) Read current inventory for every variation.
  const inventory = await getInventoryCounts(
    token,
    variationIds,
    location.id
  );

  if (!inventory.ok) {
    return json(inventory.status, {
      error: "Could not read Square inventory.",
      square: inventory.data,
    });
  }

  // 4) Convert Square's nested catalog into a simple GrowthWise-friendly list.
  const products = [];

  for (const item of catalog.items) {
    const itemData = item.item_data || {};

    for (const variation of itemData.variations || []) {
      const variationData = variation.item_variation_data || {};
      const money = variationData.price_money || {};
      const inventoryData = inventory.countMap.get(variation.id) || {
        quantity: 0,
        calculated_at: null,
      };

      const priceCents =
        typeof money.amount === "number" ? money.amount : null;

      products.push({
        item_id: item.id,
        item_name: itemData.name || "Unnamed item",
        description:
          itemData.description_plaintext ||
          itemData.description ||
          "",
        variation_id: variation.id,
        variation_name: variationData.name || "Default",
        sku: variationData.sku || null,
        upc: variationData.upc || null,
        price_cents: priceCents,
        price:
          priceCents === null ? null : (priceCents / 100).toFixed(2),
        currency: money.currency || null,
        track_inventory: Boolean(variationData.track_inventory),
        quantity: inventoryData.quantity,
        inventory_calculated_at: inventoryData.calculated_at,
        updated_at: variation.updated_at || item.updated_at || null,
      });
    }
  }

  const totalUnits = products.reduce(
    (sum, product) => sum + (Number(product.quantity) || 0),
    0
  );

  const inventoryValueCents = products.reduce((sum, product) => {
    if (product.price_cents === null) return sum;
    return sum + product.price_cents * (Number(product.quantity) || 0);
  }, 0);

  products.sort((a, b) =>
    a.item_name.localeCompare(b.item_name, undefined, {
      sensitivity: "base",
    })
  );

  return json(200, {
    ok: true,
    source: "Square Sandbox",
    square_api_version: SQUARE_VERSION,
    generated_at: new Date().toISOString(),
    location: {
      id: location.id,
      name: location.name || null,
    },
    summary: {
      item_count: catalog.items.length,
      variation_count: products.length,
      total_units_in_stock: totalUnits,
      inventory_value_cents: inventoryValueCents,
      inventory_value: (inventoryValueCents / 100).toFixed(2),
    },
    products,
  });
};
