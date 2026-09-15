import { getStore } from "@netlify/blobs";

function clean(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeToken(value) {
  return clean(value, 240).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeVin(value) {
  return clean(value, 40).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeStock(value) {
  return clean(value, 80).toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9_-]/g, "");
}

export function inventoryStore() {
  return getStore({ name: "growthwise-inventory-v1", consistency: "strong" });
}

export function normalizeInventoryRecord(record = {}) {
  const r = {
    id: clean(record.id, 120),
    stock: clean(record.stock, 80),
    vin: clean(record.vin, 40),
    vehicle: clean(record.vehicle, 240),
    year: clean(record.year, 10),
    make: clean(record.make, 80),
    model: clean(record.model, 100),
    trim: clean(record.trim, 100),
    mileage: clean(record.mileage, 80),
    asking: clean(record.asking, 80),
    status: clean(record.status, 80),
    notes: clean(record.notes, 1800),
    days_on_lot: clean(record.days_on_lot ?? record.daysOnLot, 40),
  };
  if (!r.vehicle) r.vehicle = [r.year, r.make, r.model, r.trim].filter(Boolean).join(" ");
  return r;
}

export async function saveInventorySnapshot(records = [], business = {}) {
  const normalized = Array.isArray(records)
    ? records.slice(0, 2000).map(normalizeInventoryRecord).filter((r) => r.vehicle || r.vin || r.stock)
    : [];
  const payload = {
    business: {
      name: clean(business.name, 160) || "Auto City Sales",
      address: clean(business.address, 240),
      phone: clean(business.phone, 100),
      website: clean(business.website, 220),
      market: clean(business.market, 140),
    },
    synced_at: new Date().toISOString(),
    records: normalized,
  };
  await inventoryStore().setJSON("snapshot/current", payload);
  return payload;
}

export async function getInventorySnapshot() {
  return inventoryStore().get("snapshot/current", { type: "json", consistency: "strong" });
}

function activeStatus(status) {
  const s = String(status || "").toLowerCase();
  return /for\s*sale|ready|active|aging\s*inventory|recon|photos|listing/.test(s) && !/sold|unavailable/.test(s);
}

function matchByYmm(records, vehicle) {
  const year = normalizeToken(vehicle?.year);
  const make = normalizeToken(vehicle?.make);
  const model = normalizeToken(vehicle?.model);
  if (!year || !make || !model) return null;
  const matches = records.filter((r) => normalizeToken(r.year) === year && normalizeToken(r.make) === make && normalizeToken(r.model) === model);
  if (matches.length === 1) return { record: matches[0], match_type: "year_make_model", confidence: "medium" };
  if (matches.length > 1) {
    const active = matches.filter((r) => activeStatus(r.status));
    if (active.length === 1) return { record: active[0], match_type: "year_make_model_active_unique", confidence: "medium" };
  }
  return null;
}

export async function matchInventoryVehicle(vehicle = {}) {
  const snapshot = await getInventorySnapshot();
  const records = Array.isArray(snapshot?.records) ? snapshot.records : [];
  if (!records.length) return { record: null, match_type: "none", confidence: "none", synced_at: snapshot?.synced_at || "" };

  const vin = normalizeVin(vehicle.vin);
  if (vin) {
    const found = records.find((r) => normalizeVin(r.vin) === vin);
    if (found) return { record: found, match_type: "vin", confidence: "high", synced_at: snapshot.synced_at };
  }

  const stock = normalizeStock(vehicle.stock);
  if (stock) {
    const found = records.find((r) => normalizeStock(r.stock) === stock);
    if (found) return { record: found, match_type: "stock", confidence: "high", synced_at: snapshot.synced_at };
  }

  const ymm = matchByYmm(records, vehicle);
  if (ymm) return { ...ymm, synced_at: snapshot.synced_at };

  return { record: null, match_type: "none", confidence: "none", synced_at: snapshot.synced_at };
}
