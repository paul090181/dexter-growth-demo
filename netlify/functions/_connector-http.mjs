const MAX_BODY_BYTES = 2_048;

export function connectorJson(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    pragma: "no-cache",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    ...headers,
  } });
}

export async function readConnectorJson(request) {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Error("INVALID_REQUEST");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) throw new Error("INVALID_REQUEST");
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) throw new Error("INVALID_REQUEST");
  try { return JSON.parse(text); } catch { throw new Error("INVALID_REQUEST"); }
}

export function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("INVALID_ORIGIN"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("INVALID_ORIGIN");
  }
  return url.origin;
}

export function exactKeys(body, keys) {
  return body && typeof body === "object" && !Array.isArray(body)
    && Object.keys(body).length === keys.length && keys.every((key) => Object.hasOwn(body, key));
}
