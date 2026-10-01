import { createBillingStore } from "./_billing-store.mjs";
import { hasEntitlement, resolveSubscriptionEntitlements } from "./_entitlements.mjs";
import { authorizeTenantRequest } from "./_tenant-auth.mjs";
import { createTenantStore } from "./_tenant-store.mjs";

export async function authorizeTenantSquareRequest(request, {
  businessId,
  tenantStore = createTenantStore(),
  billingStore = createBillingStore(),
  now = new Date(),
} = {}) {
  const tenantAuth = await authorizeTenantRequest(request, {
    businessId,
    store: tenantStore,
  });
  if (!tenantAuth.ok || tenantAuth.businessId !== businessId) {
    return { ok: false, via: "none", businessId: null };
  }

  let subscription;
  try {
    subscription = await billingStore.readSubscription({ businessId });
  } catch {
    return { ok: false, via: "unavailable", businessId: null };
  }

  const entitlements = resolveSubscriptionEntitlements(subscription, { now });
  if (!hasEntitlement(entitlements, "inventory_connection")) {
    return { ok: false, via: "locked", businessId: null };
  }

  return {
    ok: true,
    via: "tenant",
    businessId,
    entitlements,
  };
}
