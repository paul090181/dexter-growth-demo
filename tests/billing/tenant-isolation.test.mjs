import assert from "node:assert/strict";
import test from "node:test";

import squareDataHandler from "../../netlify/functions/square-data.mjs";

const TENANT_KEY = `gw_tenant_${"A".repeat(43)}`;

test("a tenant key cannot authorize Dexter's Square data endpoint", async () => {
  const previousNetlify = globalThis.Netlify;
  globalThis.Netlify = {
    env: {
      get(name) {
        if (name === "SQUARE_SANDBOX_TOKEN") return "square-test-token";
        if (name === "GROWTHWISE_ADMIN_KEY") return "dexter-admin-secret";
        return "";
      },
    },
  };
  try {
    const tenantHeader = await squareDataHandler(new Request("https://preview.example/.netlify/functions/square-data", {
      headers: { "x-growthwise-tenant-key": TENANT_KEY },
    }));
    assert.equal(tenantHeader.status, 401);

    const tenantKeyMasqueradingAsAdmin = await squareDataHandler(new Request("https://preview.example/.netlify/functions/square-data", {
      headers: { "x-growthwise-key": TENANT_KEY },
    }));
    assert.equal(tenantKeyMasqueradingAsAdmin.status, 401);
  } finally {
    globalThis.Netlify = previousNetlify;
  }
});
