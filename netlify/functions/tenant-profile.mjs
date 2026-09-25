import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

export function createTenantProfileHandler({ store = createTenantStore() } = {}) {
  return async function tenantProfile(request) {
    if (request.method !== "GET") return json(405, { error: "Method not allowed." });

    let url;
    try { url = new URL(request.url); }
    catch { return json(400, { error: "Invalid request." }); }

    const businessId = url.searchParams.get("business_id")?.trim() || "";
    if (!businessId || [...url.searchParams.keys()].some((key) => key !== "business_id")) {
      return json(400, { error: "Business is required." });
    }

    const auth = await authorizeTenantRequest(request, { businessId, store });
    if (!auth.ok) return json(401, { error: "Workspace ID or access key is incorrect." });

    try {
      const row = await store.readTenantProfile({ businessId });
      if (!row || row.business_id !== businessId) return json(404, { error: "Workspace not found." });
      return json(200, {
        business_id: row.business_id,
        business_name: row.business_name,
        contact_name: row.contact_name ?? null,
        contact_email: row.contact_email ?? null,
        created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      });
    } catch {
      return json(503, { error: "Workspace profile is temporarily unavailable." });
    }
  };
}

export default createTenantProfileHandler();
