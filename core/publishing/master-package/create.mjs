function normalize(value) {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child)]));
  }
  return value;
}

export function createMasterPackage(input = {}) {
  const normalized = normalize(input);
  const now = new Date().toISOString();

  return {
    ...normalized,
    business_id: normalized.business_id ?? "",
    source: normalized.source ?? null,
    item_type: normalized.item_type ?? "",
    title: normalized.title ?? "",
    description: normalized.description ?? "",
    media: normalized.media ?? [],
    verified_facts: normalized.verified_facts ?? {},
    attributes: normalized.attributes ?? {},
    source_of_truth: normalized.source_of_truth ?? {},
    approval: normalized.approval ?? {},
    created_at: normalized.created_at || now,
    updated_at: normalized.updated_at || now,
  };
}
