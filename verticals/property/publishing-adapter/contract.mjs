export const propertyPublishingAdapterContract = Object.freeze({
  vertical: "property",
  status: "contract-only",
  requiredOutputFields: Object.freeze([
    "business_id", "source", "item_type", "title", "description", "media",
    "verified_facts", "attributes", "source_of_truth", "approval",
  ]),
});
