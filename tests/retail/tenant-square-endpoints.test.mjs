import test from "node:test";
import assert from "node:assert/strict";
import { SquareAccessError } from "../../netlify/functions/_square-access.mjs";
import { createTenantSquareInventoryHandler } from "../../netlify/functions/tenant-square-inventory.mjs";
import { createTenantSquareSalesHandler } from "../../netlify/functions/tenant-square-sales.mjs";

function request(path) {
  return new Request(`https://example.test${path}`, {
    method: "GET",
    headers: { "x-growthwise-tenant-key": "gw_tenant_synthetic" },
  });
}

test("tenant inventory never reads Square before tenant entitlement authorization", async () => {
  let squareCalls = 0;
  for (const [via, expected] of [["none", 401], ["locked", 403], ["unavailable", 503]]) {
    const handler = createTenantSquareInventoryHandler({
      authorize: async () => ({ ok: false, via }),
      squareAccess: async () => { squareCalls += 1; },
    });
    const response = await handler(
      request("/.netlify/functions/tenant-square-inventory?business_id=tenant-a"),
    );
    assert.equal(response.status, expected);
  }
  assert.equal(squareCalls, 0);
});

test("tenant inventory passes only the authorized business token to Square reads", async () => {
  const calls = [];
  const handler = createTenantSquareInventoryHandler({
    authorize: async (_request, input) => {
      calls.push({ kind: "auth", input });
      return { ok: true, via: "tenant", businessId: input.businessId };
    },
    squareAccess: async ({ businessId }) => {
      calls.push({ kind: "access", businessId });
      return {
        accessToken: "tenant-a-token",
        environment: "sandbox",
        refreshed: false,
      };
    },
    readInventory: async (input) => {
      calls.push({ kind: "inventory", input });
      return {
        location: { id: "LOC1", name: "Tenant A" },
        summary: { item_count: 1 },
        products: [{ item_id: "ITEM1", item_name: "Hat" }],
      };
    },
  });

  const response = await handler(
    request("/.netlify/functions/tenant-square-inventory?business_id=tenant-a"),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.business_id, "tenant-a");
  assert.equal(body.products[0].item_name, "Hat");
  assert.deepEqual(
    calls.find((call) => call.kind === "inventory").input,
    { accessToken: "tenant-a-token", environment: "sandbox" },
  );
});

test("tenant inventory requires a connection without exposing stored credential details", async () => {
  const handler = createTenantSquareInventoryHandler({
    authorize: async () => ({ ok: true, via: "tenant", businessId: "tenant-a" }),
    squareAccess: async () => { throw new SquareAccessError("not_connected"); },
  });
  const response = await handler(
    request("/.netlify/functions/tenant-square-inventory?business_id=tenant-a"),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(body, { error: "Connect Square before using inventory." });
});

test("tenant sales validates days and keeps business selector tenant-bound", async () => {
  const handler = createTenantSquareSalesHandler({
    authorize: async (_request, input) => ({
      ok: true,
      via: "tenant",
      businessId: input.businessId,
    }),
    squareAccess: async ({ businessId }) => ({
      accessToken: `${businessId}-token`,
      environment: "sandbox",
      refreshed: true,
    }),
    readSales: async (input) => ({
      period_days: input.days,
      location: { id: "LOC1", name: "Tenant A" },
      summary: { completed_order_count: 2 },
      top_products: [],
      recent_orders: [],
    }),
    now: () => new Date("2026-09-25T14:00:00Z"),
  });

  assert.equal(
    (await handler(request(
      "/.netlify/functions/tenant-square-sales?business_id=tenant-a&days=0",
    ))).status,
    400,
  );
  assert.equal(
    (await handler(request(
      "/.netlify/functions/tenant-square-sales?business_id=tenant-a&days=30&extra=1",
    ))).status,
    400,
  );

  const response = await handler(request(
    "/.netlify/functions/tenant-square-sales?business_id=tenant-a&days=30",
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.business_id, "tenant-a");
  assert.equal(body.period_days, 30);
  assert.equal(body.refreshed_token, true);
});
