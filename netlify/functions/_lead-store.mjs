import { getStore } from "@netlify/blobs";
import { createHash, randomUUID } from "node:crypto";

export function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

export function clean(value, max = 5000) {
  return String(value ?? "").trim().slice(0, max);
}

export function leadStore() {
  return getStore("growthwise-leads-v1");
}

export function leadKey({ source, externalId }) {
  const src = clean(source, 200) || "unknown";
  const ext = clean(externalId, 300);
  if (ext) {
    const digest = createHash("sha256").update(`${src}|${ext}`).digest("hex").slice(0, 32);
    return `lead/${digest}`;
  }
  return `lead/${Date.now()}-${randomUUID()}`;
}

export async function saveLead(record, { onlyIfNew = false } = {}) {
  const store = leadStore();
  return store.setJSON(record._key, record, { onlyIfNew });
}

export async function getLead(key) {
  return leadStore().get(key, { type: "json", consistency: "strong" });
}

export async function listLeads(limit = 50) {
  const store = leadStore();
  const { blobs = [] } = await store.list({ prefix: "lead/" });
  const rows = (await Promise.all(blobs.map(async ({ key }) => {
    try { return await store.get(key, { type: "json", consistency: "strong" }); }
    catch { return null; }
  }))).filter(Boolean);
  rows.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  return rows.slice(0, limit);
}

export function authorized(request, { allowLeadKey = false } = {}) {
  const adminKey = Netlify.env.get("GROWTHWISE_ADMIN_KEY") || "";
  const ingestKey = allowLeadKey ? (Netlify.env.get("GROWTHWISE_LEAD_INGEST_KEY") || "") : "";
  const suppliedAdmin = request.headers.get("x-growthwise-key") || "";
  const suppliedLead = request.headers.get("x-growthwise-lead-key") || "";
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  if (adminKey && suppliedAdmin === adminKey) return { ok: true, via: "admin" };
  if (allowLeadKey && ingestKey && (suppliedLead === ingestKey || bearer === ingestKey)) return { ok: true, via: "lead_key" };
  return { ok: false, via: "none" };
}

export function normalizeVehicle(vehicle) {
  if (!vehicle || typeof vehicle !== "object") return null;
  const v = {
    vehicle: clean(vehicle.vehicle, 240),
    stock: clean(vehicle.stock, 80),
    vin: clean(vehicle.vin, 40),
    year: clean(vehicle.year, 10),
    make: clean(vehicle.make, 80),
    model: clean(vehicle.model, 100),
    trim: clean(vehicle.trim, 100),
    mileage: clean(vehicle.mileage, 80),
    asking: clean(vehicle.asking, 80),
    status: clean(vehicle.status, 80),
    notes: clean(vehicle.notes, 1800),
    days_on_lot: clean(vehicle.days_on_lot, 40),
  };
  if (!v.vehicle) v.vehicle = [v.year, v.make, v.model, v.trim].filter(Boolean).join(" ");
  return Object.values(v).some(Boolean) ? v : null;
}

export function normalizeBusiness(business) {
  const b = business && typeof business === "object" ? business : {};
  return {
    name: clean(b.name, 160) || "Auto City Sales",
    address: clean(b.address, 240) || "427 Hertel Ave, Buffalo, NY 14207",
    phone: clean(b.phone, 100) || "(716) 406-7555",
    website: clean(b.website, 220) || "https://autocitysales.net",
    market: clean(b.market, 140) || "Buffalo, NY",
  };
}
