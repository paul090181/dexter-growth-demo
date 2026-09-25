export function resolveGrowthWisePublicOrigin(
  get = (name) => Netlify.env.get(name) || "",
) {
  for (const name of ["DEPLOY_PRIME_URL", "GROWTHWISE_PUBLIC_ORIGIN"]) {
    const value = String(get(name) || "").trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && url.origin === value) return value;
    } catch {
      // Try the next configured origin.
    }
  }
  return "";
}
