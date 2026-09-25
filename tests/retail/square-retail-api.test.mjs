import test from "node:test";
import assert from "node:assert/strict";
import { readSquareInventory, readSquareSales } from "../../netlify/functions/_square-retail-api.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("tenant Square inventory uses the supplied tenant token and produces GrowthWise product rows", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v2/locations")) {
      return jsonResponse({ locations: [{ id: "LOC1", name: "Tenant Shop", status: "ACTIVE" }] });
    }
    if (url.endsWith("/v2/catalog/search-catalog-items")) {
      return jsonResponse({
        items: [{
          id: "ITEM1",
          item_data: {
            name: "Classic Hat",
            variations: [{
              id: "VAR1",
              item_variation_data: {
                name: "Black",
                sku: "SKU1",
                price_money: { amount: 12500, currency: "USD" },
                track_inventory: true,
              },
            }],
          },
        }],
      });
    }
    if (url.endsWith("/v2/inventory/counts/batch-retrieve")) {
      return jsonResponse({
        counts: [{
          catalog_object_id: "VAR1",
          location_id: "LOC1",
          state: "IN_STOCK",
          quantity: "3",
        }],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await readSquareInventory({
    accessToken: "tenant-token",
    environment: "sandbox",
    fetchImpl,
  });

  assert.equal(result.products[0].item_name, "Classic Hat");
  assert.equal(result.products[0].quantity, 3);
  assert.equal(result.products[0].price, "125.00");
  assert.equal(result.summary.inventory_value, "375.00");
  assert.equal(
    calls.every((call) => call.init.headers.authorization === "Bearer tenant-token"),
    true,
  );
  assert.equal(
    calls.every((call) => call.url.startsWith("https://connect.squareupsandbox.com/")),
    true,
  );
});

test("tenant Square sales uses only completed orders and computes sales summary", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/v2/locations")) {
      return jsonResponse({ locations: [{ id: "LOC1", name: "Tenant Shop", status: "ACTIVE" }] });
    }
    if (url.endsWith("/v2/orders/search")) {
      return jsonResponse({
        orders: [
          {
            id: "ORDER1",
            state: "COMPLETED",
            created_at: "2026-09-24T12:00:00Z",
            total_money: { amount: 15000, currency: "USD" },
            total_tax_money: { amount: 1000, currency: "USD" },
            total_discount_money: { amount: 500, currency: "USD" },
            net_amounts: { total_money: { amount: 15000, currency: "USD" } },
            line_items: [{
              catalog_object_id: "VAR1",
              name: "Classic Hat",
              variation_name: "Black",
              quantity: "1",
              gross_sales_money: { amount: 14500, currency: "USD" },
              total_money: { amount: 14500, currency: "USD" },
              total_discount_money: { amount: 500, currency: "USD" },
            }],
          },
          {
            id: "OPEN",
            state: "OPEN",
            total_money: { amount: 99999, currency: "USD" },
          },
        ],
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };

  const result = await readSquareSales({
    accessToken: "tenant-token",
    environment: "sandbox",
    days: 30,
    now: new Date("2026-09-25T14:00:00Z"),
    fetchImpl,
  });

  assert.equal(result.summary.completed_order_count, 1);
  assert.equal(result.summary.total_collected, "150.00");
  assert.equal(result.top_products[0].item_name, "Classic Hat");
  assert.equal(result.recent_orders.length, 1);
  assert.equal(
    calls.every((call) => call.init.headers.authorization === "Bearer tenant-token"),
    true,
  );
});
