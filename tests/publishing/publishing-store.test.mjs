import test from "node:test";
import assert from "node:assert/strict";
import { auditKey, jobKey, readBusinessRecord, saveShadowRun } from "../../netlify/functions/_publishing-store.mjs";

function fakeStore() {
  const values = new Map();
  return {
    values,
    async setJSON(key, value) { values.set(key, value); },
    async get(key) { return values.get(key) ?? null; },
  };
}

test("shadow records use business-scoped keys", async () => {
  const store = fakeStore();
  const job = { business_id: "auto-city", idempotency_key: "abc", status: "Draft" };
  const event = { business_id: "auto-city", event_id: "evt-1", timestamp: "2026-09-17T10:00:00.000Z" };
  assert.equal(jobKey(job), "business/auto-city/job/abc");
  assert.equal(auditKey(event), "business/auto-city/audit/2026-09-17T10:00:00.000Z-evt-1");
  await saveShadowRun({ business_id: "auto-city", results: [{ job }], audit_events: [event] }, { store });
  assert.deepEqual([...store.values.keys()], [jobKey(job), auditKey(event)]);
});

test("tenant-safe persistence and reads reject mismatched records", async () => {
  const store = fakeStore();
  const mismatched = { business_id: "dexters-hats", idempotency_key: "abc" };
  await assert.rejects(
    saveShadowRun({ business_id: "auto-city", results: [{ job: mismatched }], audit_events: [] }, { store }),
    /tenant mismatch/i,
  );
  store.values.set("business/auto-city/job/abc", { business_id: "dexters-hats" });
  await assert.rejects(readBusinessRecord("auto-city", "job/abc", { store }), /tenant mismatch/i);
});
