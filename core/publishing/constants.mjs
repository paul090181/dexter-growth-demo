export const DELIVERY_MODES = Object.freeze(["direct", "assisted", "export"]);

export const AUTOMATION_LEVELS = Object.freeze(["manual", "review", "automatic"]);

export const ROLES = Object.freeze(["owner_admin", "manager", "staff", "view_only"]);

export const JOB_STATUSES = Object.freeze([
  "Draft",
  "Waiting Approval",
  "Queued",
  "Processing",
  "Published",
  "Retry Scheduled",
  "Needs Attention",
  "Failed",
  "Removed",
]);
