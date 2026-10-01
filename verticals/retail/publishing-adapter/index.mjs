function productTitle(product) {
  const name = product.name || "";
  const brand = product.brand || "";
  return brand && !name.toLocaleLowerCase().includes(brand.toLocaleLowerCase())
    ? `${brand} ${name}`.trim()
    : name;
}

export function retailToMasterInput({ businessId, product = {}, media = [], business = {} } = {}) {
  return {
    business_id: businessId,
    source: { type: "retail-catalog", id: product.sku },
    item_type: "product",
    title: productTitle(product),
    description: product.description || product.name || "",
    media,
    verified_facts: {
      sku: product.sku,
      quantity: product.quantity,
      price: product.price,
      availability: product.quantity > 0 ? "available" : "unavailable",
    },
    attributes: {
      brand: product.brand,
      color: product.color,
      size: product.size,
      variant: product.variant,
      businessName: business.name,
    },
    source_of_truth: { mode: "growthwise" },
    approval: { status: "draft" },
  };
}
