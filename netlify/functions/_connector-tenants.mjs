import growthwiseDev from "../../clients/growthwise-dev.json" with { type: "json" };
import dextersHats from "../../clients/dexters-hats.json" with { type: "json" };

const DEFAULT_PILOTS = Object.freeze({
  [growthwiseDev.business_id]: growthwiseDev,
  [dextersHats.business_id]: dextersHats,
});

export function createConnectorTenantResolver({ pilotTenants = DEFAULT_PILOTS, tenantStore } = {}) {
  return async function resolveConnectorTenant(businessId) {
    const id = typeof businessId === "string" ? businessId.trim() : "";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 80) return null;
    const pilot = pilotTenants[id];
    if (pilot?.business_id === id && typeof pilot.display_name === "string" && pilot.display_name.trim()) {
      return { business_id: id, business_name: pilot.display_name.trim(), source: "pilot" };
    }
    try {
      const row = await tenantStore?.readTenantProfile?.({ businessId: id });
      if (row?.business_id === id && typeof row.business_name === "string" && row.business_name.trim()) {
        return { business_id: id, business_name: row.business_name.trim(), source: "database" };
      }
    } catch { /* fail closed */ }
    return null;
  };
}
