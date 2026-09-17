export function automotiveToMasterInput({ businessId, vehicle = {}, media = [], business = {} } = {}) {
  const title = [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(" ");

  return {
    business_id: businessId,
    source: { type: "automotive-inventory", id: vehicle.stock },
    item_type: "vehicle",
    title,
    description: vehicle.description || title,
    media,
    verified_facts: {
      vin: vehicle.vin,
      stock: vehicle.stock,
      mileage: vehicle.mileage,
      price: vehicle.asking,
      availability: vehicle.status,
    },
    attributes: {
      year: vehicle.year,
      make: vehicle.make,
      model: vehicle.model,
      trim: vehicle.trim,
      bodyStyle: vehicle.bodyStyle,
      exteriorColor: vehicle.exteriorColor,
      businessName: business.name,
    },
    source_of_truth: { mode: "growthwise" },
    approval: { status: "draft" },
  };
}
