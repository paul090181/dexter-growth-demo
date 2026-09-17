export const servicesPublishingAdapterContract = Object.freeze({
  vertical: "services",
  status: "contract-only",
  requiredOutputFields: Object.freeze([
    "business_id", "source", "item_type", "title", "description", "media",
    "verified_facts", "attributes", "source_of_truth", "approval",
  ]),
});
