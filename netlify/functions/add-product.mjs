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
      return { ok: false, status: response.status, data: { raw: text } };
    }
  }

  return { ok: response.ok, status: response.status, data };
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-GrowthWise-Key",
      },
    });
  }

  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const token = Netlify.env.get("SQUARE_SANDBOX_TOKEN");
  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY");

  if (!token || !adminKey) {
    return json(500, { error: "Server configuration is incomplete." });
  }

  const suppliedKey = request.headers.get("x-growthwise-key") || "";
  if (suppliedKey !== adminKey) {
    return json(401, { error: "Invalid GrowthWise admin key." });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON body." });
  }

  const brand = String(body.brand || "").trim();
  const productName = String(body.productName || "").trim();
  const description = String(body.description || "").trim();
  const price = Number(body.price);
  const quantity = Number(body.quantity);

  if (!productName) {
    return json(400, { error: "Product name is required." });
  }
  if (!Number.isFinite(price) || price < 0) {
    return json(400, { error: "Price must be a valid non-negative number." });
  }
  if (!Number.isInteger(quantity) || quantity < 0) {
    return json(400, { error: "Quantity must be a whole number 0 or greater." });
  }

  const fullName = brand ? `${brand} ${productName}` : productName;
  const priceCents = Math.round(price * 100);

  const locations = await square("/v2/locations", token, { method: "GET" });
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
    return json(400, { error: "No active Square location was found." });
  }

  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const itemTempId = `#gw-item-${suffix}`;
  const variationTempId = `#gw-var-${suffix}`;

  const itemData = {
    name: fullName,
    variations: [
      {
        id: variationTempId,
        type: "ITEM_VARIATION",
        present_at_all_locations: true,
        item_variation_data: {
          item_id: itemTempId,
          name: "Default",
          pricing_type: "FIXED_PRICING",
          price_money: {
            amount: priceCents,
            currency: "USD",
          },
          track_inventory: true,
        },
      },
    ],
  };

  if (description) itemData.description = description;

  const catalog = await square("/v2/catalog/object", token, {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      object: {
        id: itemTempId,
        type: "ITEM",
        present_at_all_locations: true,
        item_data: itemData,
      },
    }),
  });

  if (!catalog.ok) {
    return json(catalog.status, {
      error: "Square could not create the product.",
      square: catalog.data,
    });
  }

  const variationMapping = (catalog.data.id_mappings || []).find(
    (mapping) => mapping.client_object_id === variationTempId
  );

  if (!variationMapping?.object_id) {
    return json(500, {
      error: "Product was created, but Square did not return the variation ID.",
      square: catalog.data,
    });
  }

  const variationId = variationMapping.object_id;

  const inventory = await square("/v2/inventory/changes/batch-create", token, {
    method: "POST",
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      changes: [
        {
          type: "PHYSICAL_COUNT",
          physical_count: {
            catalog_object_id: variationId,
            location_id: location.id,
            state: "IN_STOCK",
            quantity: String(quantity),
            occurred_at: new Date().toISOString(),
          },
        },
      ],
      ignore_unchanged_counts: true,
    }),
  });

  if (!inventory.ok) {
    return json(inventory.status, {
      error:
        "Product was created in Square, but the initial inventory count failed.",
      productCreated: true,
      itemId: catalog.data.catalog_object?.id || null,
      variationId,
      square: inventory.data,
    });
  }

  return json(200, {
    ok: true,
    message: "Product created in Square Sandbox.",
    product: {
      name: fullName,
      price: price.toFixed(2),
      quantity,
      itemId: catalog.data.catalog_object?.id || null,
      variationId,
      locationId: location.id,
      locationName: location.name || null,
    },
  });
};
      
