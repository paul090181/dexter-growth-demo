const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles";

function json(status, body, cacheSeconds = 0) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });
}

function clean(value, max = 200) {
  return String(value ?? "").trim().slice(0, max);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { "Accept": "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`NHTSA vehicle data request failed (HTTP ${response.status}).`);
  return data;
}

function uniqueSorted(values) {
  return [...new Set(values.map(v => clean(v)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export default async (request) => {
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });

  const url = new URL(request.url);
  const action = clean(url.searchParams.get("action"), 30).toLowerCase();

  try {
    if (action === "makes") {
      const data = await getJson(`${VPIC}/GetAllMakes?format=json`);
      const makes = uniqueSorted((data?.Results || []).map(r => r?.Make_Name || r?.MakeName));
      return json(200, { ok: true, makes }, 86400);
    }

    if (action === "models") {
      const year = clean(url.searchParams.get("year"), 10);
      const make = clean(url.searchParams.get("make"), 80);
      if (!/^\d{4}$/.test(year) || !make) return json(400, { error: "A four-digit year and make are required." });
      if (Number(year) < 1996) return json(200, { ok: true, models: [], manual_required: true }, 86400);
      const endpoint = `${VPIC}/GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${encodeURIComponent(year)}?format=json`;
      const data = await getJson(endpoint);
      const models = uniqueSorted((data?.Results || []).map(r => r?.Model_Name || r?.ModelName));
      return json(200, { ok: true, models, manual_required: models.length === 0 }, 86400);
    }

    if (action === "decode") {
      const vin = clean(url.searchParams.get("vin"), 40).replace(/[^A-Za-z0-9*]/g, "").toUpperCase();
      const modelYear = clean(url.searchParams.get("modelyear"), 10);
      if (vin.length < 8) return json(400, { error: "Enter at least 8 VIN characters." });
      const yearPart = /^\d{4}$/.test(modelYear) ? `&modelyear=${encodeURIComponent(modelYear)}` : "";
      const data = await getJson(`${VPIC}/DecodeVinValues/${encodeURIComponent(vin)}?format=json${yearPart}`);
      const r = data?.Results?.[0] || {};
      return json(200, {
        ok: true,
        vin,
        error_code: clean(r.ErrorCode, 100),
        error_text: clean(r.ErrorText, 1000),
        year: clean(r.ModelYear, 10),
        make: clean(r.Make, 80),
        model: clean(r.Model, 100),
        trim: clean(r.Trim || r.Trim2, 120),
        vehicle_type: clean(r.VehicleType, 120),
        body_class: clean(r.BodyClass, 120),
        doors: clean(r.Doors, 20),
        drive_type: clean(r.DriveType, 100),
        fuel_type: clean(r.FuelTypePrimary, 100),
        engine_cylinders: clean(r.EngineCylinders, 40),
        displacement_l: clean(r.DisplacementL, 40),
        transmission: clean(r.TransmissionStyle, 120),
      }, 3600);
    }

    return json(400, { error: "Unknown vehicle-data action." });
  } catch (error) {
    return json(502, { error: error?.message || "Vehicle data lookup failed." });
  }
};
