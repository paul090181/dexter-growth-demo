import { randomUUID } from "node:crypto";

function required(value, name) {
  if (value === undefined || value === null
    || (typeof value === "string" && value.trim() === "")) {
    throw new TypeError(`${name} is required`);
  }
}

/** Create an immutable-in-practice, tenant-scoped record of a publishing action. */
export function createAuditEvent({
  businessId,
  actor,
  action,
  entityType,
  entityId,
  details = {},
} = {}) {
  required(businessId, "businessId");
  required(actor, "actor");
  required(action, "action");
  required(entityType, "entityType");
  required(entityId, "entityId");

  return {
    event_id: randomUUID(),
    business_id: businessId,
    actor: structuredClone(actor),
    action,
    entity_type: entityType,
    entity_id: entityId,
    details: structuredClone(details),
    created_at: new Date().toISOString(),
  };
}
