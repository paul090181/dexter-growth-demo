export const DEFAULT_BILLING_TENANTS = new Set(["growthwise-dev", "dexters-hats"]);

export function billingTenantsFromEnvironment(value = "") {
  const configured = String(value)
    .split(",")
    .map((tenant) => tenant.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_BILLING_TENANTS, ...configured]);
}
