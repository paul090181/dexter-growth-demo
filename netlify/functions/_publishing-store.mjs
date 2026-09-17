import { getStore } from "@netlify/blobs";

function requiredSegment(value, name) {
  const segment = String(value ?? "").trim();
  if (!segment) throw new TypeError(`${name} is required`);
  if (segment.includes("/") || segment === "." || segment === "..") {
    throw new TypeError(`${name} contains an invalid key segment`);
  }
  return segment;
}

function assertTenant(businessId, record) {
  if (record?.business_id !== businessId) {
    throw new Error("Publishing tenant mismatch");
  }
}

export function publishingStore() {
  return getStore({ name: "growthwise-publishing-v1", consistency: "strong" });
}

export function jobKey(job) {
  const businessId = requiredSegment(job?.business_id, "job.business_id");
  const idempotencyKey = requiredSegment(job?.idempotency_key, "job.idempotency_key");
  return `business/${businessId}/job/${idempotencyKey}`;
}

export function auditKey(event) {
  const businessId = requiredSegment(event?.business_id, "event.business_id");
  const timestamp = requiredSegment(event?.timestamp ?? event?.created_at, "event.timestamp");
  const eventId = requiredSegment(event?.event_id, "event.event_id");
  return `business/${businessId}/audit/${timestamp}-${eventId}`;
}

export async function saveShadowRun(run, { store = publishingStore() } = {}) {
  const businessId = requiredSegment(run?.business_id, "run.business_id");
  const writes = [];
  for (const result of run?.results ?? []) {
    if (!result.job) continue;
    assertTenant(businessId, result.job);
    writes.push(store.setJSON(jobKey(result.job), result.job));
  }
  for (const event of run?.audit_events ?? []) {
    assertTenant(businessId, event);
    writes.push(store.setJSON(auditKey(event), event));
  }
  await Promise.all(writes);
  return run;
}

/** Tenant-safe diagnostic read; relativeKey must remain inside the business prefix. */
export async function readBusinessRecord(businessId, relativeKey, { store = publishingStore() } = {}) {
  const tenant = requiredSegment(businessId, "businessId");
  const relative = String(relativeKey ?? "");
  if (!/^(job|audit)\/[^/]+$/.test(relative)) throw new TypeError("Invalid publishing record key");
  const record = await store.get(`business/${tenant}/${relative}`, { type: "json", consistency: "strong" });
  if (record) assertTenant(tenant, record);
  return record;
}
