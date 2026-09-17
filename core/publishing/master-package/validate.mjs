const REQUIRED_FIELDS = [
  "business_id",
  "source",
  "item_type",
  "title",
  "description",
  "media",
  "verified_facts",
  "attributes",
  "source_of_truth",
  "approval",
  "created_at",
  "updated_at",
];

const SOURCE_OF_TRUTH_MODES = new Set(["growthwise", "external", "bidirectional"]);

function missing(value) {
  return value === undefined || value === null
    || (typeof value === "string" && value.trim() === "");
}

export function validateMasterPackage(pkg) {
  const errors = [];

  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
    return { ok: false, errors: ["master package must be an object"] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (missing(pkg[field])) errors.push(`${field} is required`);
  }

  if (!Array.isArray(pkg.media)) {
    errors.push("media must be an array");
  } else {
    pkg.media.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") {
        errors.push(`media[${index}] must be an object`);
        return;
      }
      if (!entry.id) errors.push(`media[${index}].id is required`);
      if (!new Set(["image", "video"]).has(entry.type)) {
        errors.push(`media[${index}].type must be image or video`);
      }
      if (!entry.url) errors.push(`media[${index}].url is required`);
      if (!Number.isInteger(entry.order) || entry.order < 0) {
        errors.push(`media[${index}].order must be a non-negative integer`);
      }
      if (typeof entry.approved !== "boolean") {
        errors.push(`media[${index}].approved must be a boolean`);
      }
    });
  }

  if (!SOURCE_OF_TRUTH_MODES.has(pkg.source_of_truth?.mode)) {
    errors.push("source_of_truth.mode must be growthwise, external, or bidirectional");
  }

  return { ok: errors.length === 0, errors };
}
