import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getDatabase } from "@netlify/database";
import { hashTenantAccessKey } from "./_tenant-auth.mjs";
import { createSquareOAuthStartHandler } from "./square-oauth-start.mjs";
import { createSquareCrypto } from "./_square-crypto.mjs";
import { previewAcceptanceKey, squareCryptoVersion } from "./_square-preview-secrets.mjs";
import { createSquareStore } from "./_square-store.mjs";
import { getSquareAccess } from "./_square-access.mjs";
import { retrieveSquareTokenStatus, SQUARE_API_VERSION, SQUARE_OAUTH_SCOPES } from "./_square-oauth.mjs";
import { createTenantSquareInventoryHandler } from "./tenant-square-inventory.mjs";
import { createTenantSquareSalesHandler } from "./tenant-square-sales.mjs";

const PREVIEW_ORIGIN = "https://deploy-preview-16--euphonious-beijinho-db4b4d.netlify.app";
const PATH = "/.netlify/functions/preview16-square-acceptance";

function env(name) { return globalThis.Netlify?.env?.get(name) || ""; }

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
    },
  });
}

function html(status, title, lines = [], kind = "neutral") {
  const esc = (value) => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  const accent = kind === "pass" ? "#225c34" : kind === "fail" ? "#87372e" : "#14202c";
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>body{margin:0;background:#eef1f4;color:#14202c;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:680px;margin:0 auto;min-height:100vh;background:#fff;padding:28px 18px}.card{border:1px solid #e0e5e9;border-radius:18px;padding:20px}.result{font-size:30px;font-weight:900;color:${accent};margin-bottom:12px}.line{padding:8px 0;border-bottom:1px solid #edf0f2}.muted{color:#65717c;font-size:13px;margin-top:18px}</style></head><body><main><div class="card"><div class="result">${esc(title)}</div>${lines.map((line)=>`<div class="line">${esc(line)}</div>`).join("")}<div class="muted">Preview #16 only. Production untouched.</div></div></main></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    },
  });
}

function redirect(location) {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function ids(secret) {
  const suffix = createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 10);
  const tenantKey = (label) =>
    `gw_tenant_${createHmac("sha256", secret).update(label, "utf8").digest("base64url")}`;
  return {
    primaryId: `gw-square-accept-a-${suffix}`,
    controlId: `gw-square-accept-b-${suffix}`,
    primaryKey: tenantKey("primary"),
    controlKey: tenantKey("control"),
  };
}

function cryptoForSquare() {
  return createSquareCrypto({
    bindingSecrets: squareCryptoVersion("GROWTHWISE_SQUARE_ACCOUNT_BINDING_SECRET"),
    credentialKeys: squareCryptoVersion("GROWTHWISE_SQUARE_CREDENTIAL_ENCRYPTION_KEY"),
  });
}

async function cleanupRows(pool, { primaryId, controlId }) {
  const ids = [primaryId, controlId];
  await pool.query("DELETE FROM square_credentials WHERE business_id = ANY($1::text[])", [ids]);
  await pool.query("DELETE FROM square_oauth_transactions WHERE business_id = ANY($1::text[])", [ids]);
  await pool.query("DELETE FROM growthwise_subscriptions WHERE business_id = ANY($1::text[])", [ids]);
  await pool.query("DELETE FROM growthwise_tenants WHERE business_id = ANY($1::text[])", [ids]);
}

async function insertTenant(pool, businessId, businessName, tenantKey) {
  await pool.query(
    `INSERT INTO growthwise_tenants
      (business_id, business_name, contact_name, contact_email, access_key_hash)
     VALUES ($1,$2,$3,$4,$5)`,
    [
      businessId,
      businessName,
      "GrowthWise Acceptance",
      `${businessId}@example.invalid`,
      hashTenantAccessKey(tenantKey),
    ],
  );
  await pool.query(
    `INSERT INTO growthwise_subscriptions
      (business_id, access_source, plan_key, status, plan_started_at)
     VALUES ($1,'pilot','growth_monthly','pilot',CURRENT_TIMESTAMP)`,
    [businessId],
  );
}

async function startAcceptance(pool, identity) {
  await cleanupRows(pool, identity);
  await insertTenant(pool, identity.primaryId, "Square Acceptance Primary", identity.primaryKey);
  await insertTenant(pool, identity.controlId, "Square Acceptance Control", identity.controlKey);

  const handler = createSquareOAuthStartHandler();
  const request = new Request(`${PREVIEW_ORIGIN}/.netlify/functions/square-oauth-start`, {
    method: "POST",
    headers: {
      origin: PREVIEW_ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "x-growthwise-tenant-key": identity.primaryKey,
    },
    body: JSON.stringify({ business_id: identity.primaryId }),
  });
  const response = await handler(request);
  const body = await response.json().catch(() => ({}));
  if (response.status !== 200 || typeof body.authorization_url !== "string") {
    await cleanupRows(pool, identity);
    return json(500, {
      ok: false,
      stage: "oauth_start",
      status: response.status,
      error: body.error || "Square OAuth start failed.",
    });
  }

  let url;
  try { url = new URL(body.authorization_url); }
  catch {
    await cleanupRows(pool, identity);
    return json(500, { ok: false, stage: "authorization_url", error: "Invalid authorization URL." });
  }
  if (url.origin !== "https://connect.squareupsandbox.com"
    || url.pathname !== "/oauth2/authorize") {
    await cleanupRows(pool, identity);
    return json(500, { ok: false, stage: "authorization_url", error: "Unsafe authorization URL." });
  }

  return json(200, {
    ok: true,
    stage: "awaiting_square_authorization",
    business_id: identity.primaryId,
    control_business_id: identity.controlId,
    authorization_url: url.toString(),
    production_touched: false,
  });
}

async function statusAcceptance(pool, identity) {
  const squareCrypto = cryptoForSquare();
  const squareStore = createSquareStore({ crypto: squareCrypto });
  const credential = await squareStore.readDecryptedCredential({ businessId: identity.primaryId });
  const control = await squareStore.readCredential({ businessId: identity.controlId });

  if (!credential) {
    const tx = await pool.query(
      `SELECT status FROM square_oauth_transactions
        WHERE business_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [identity.primaryId],
    );
    return json(200, {
      ok: true,
      stage: "awaiting_square_authorization",
      transaction_status: tx.rows[0]?.status || null,
      production_touched: false,
    });
  }

  const access = await getSquareAccess({ businessId: identity.primaryId });
  const tokenStatus = await retrieveSquareTokenStatus({
    accessToken: access.accessToken,
    environment: access.environment,
  });
  const requiredScopesPresent = SQUARE_OAUTH_SCOPES.every((scope) =>
    tokenStatus.scopes.includes(scope));

  const inventoryHandler = createTenantSquareInventoryHandler();
  const salesHandler = createTenantSquareSalesHandler();

  const primaryInventory = await inventoryHandler(new Request(
    `${PREVIEW_ORIGIN}/.netlify/functions/tenant-square-inventory?business_id=${encodeURIComponent(identity.primaryId)}`,
    { method: "GET", headers: { "x-growthwise-tenant-key": identity.primaryKey } },
  ));
  const inventoryBody = await primaryInventory.json().catch(() => ({}));

  const primarySales = await salesHandler(new Request(
    `${PREVIEW_ORIGIN}/.netlify/functions/tenant-square-sales?business_id=${encodeURIComponent(identity.primaryId)}&days=30`,
    { method: "GET", headers: { "x-growthwise-tenant-key": identity.primaryKey } },
  ));
  const salesBody = await primarySales.json().catch(() => ({}));

  const wrongTenant = await inventoryHandler(new Request(
    `${PREVIEW_ORIGIN}/.netlify/functions/tenant-square-inventory?business_id=${encodeURIComponent(identity.primaryId)}`,
    { method: "GET", headers: { "x-growthwise-tenant-key": identity.controlKey } },
  ));

  const controlInventory = await inventoryHandler(new Request(
    `${PREVIEW_ORIGIN}/.netlify/functions/tenant-square-inventory?business_id=${encodeURIComponent(identity.controlId)}`,
    { method: "GET", headers: { "x-growthwise-tenant-key": identity.controlKey } },
  ));

  return json(200, {
    ok: primaryInventory.status === 200
      && primarySales.status === 200
      && wrongTenant.status === 401
      && controlInventory.status === 409
      && !control
      && requiredScopesPresent,
    stage: "authorized",
    square_environment: credential.environment,
    connected_status: credential.status,
    required_scopes_present: requiredScopesPresent,
    granted_scope_count: tokenStatus.scopes.length,
    inventory_endpoint_status: primaryInventory.status,
    sales_endpoint_status: primarySales.status,
    cross_tenant_request_status: wrongTenant.status,
    control_tenant_inventory_status: controlInventory.status,
    control_tenant_has_square_credential: Boolean(control),
    inventory_item_count: inventoryBody?.summary?.item_count ?? null,
    inventory_variation_count: inventoryBody?.summary?.variation_count ?? null,
    completed_order_count_30d: salesBody?.summary?.completed_order_count ?? null,
    token_refreshed_during_test: access.refreshed === true,
    production_touched: false,
  });
}

async function revokeAcceptanceToken(credential) {
  if (!credential?.payload?.access_token) return { attempted: false, success: null };
  const applicationId = env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_ID");
  const applicationSecret = env("GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET");
  if (!applicationId || !applicationSecret) return { attempted: false, success: false };

  try {
    const response = await fetch("https://connect.squareupsandbox.com/oauth2/revoke", {
      method: "POST",
      headers: {
        Authorization: `Client ${applicationSecret}`,
        "Square-Version": SQUARE_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: applicationId,
        access_token: credential.payload.access_token,
        revoke_only_access_token: true,
      }),
    });
    const body = await response.json().catch(() => ({}));
    return { attempted: true, success: response.ok && body.success === true };
  } catch {
    return { attempted: true, success: false };
  }
}

async function cleanupAcceptance(pool, identity) {
  const squareStore = createSquareStore({ crypto: cryptoForSquare() });
  let credential = null;
  try {
    credential = await squareStore.readDecryptedCredential({ businessId: identity.primaryId });
  } catch {}
  const revocation = await revokeAcceptanceToken(credential);
  await cleanupRows(pool, identity);

  const checks = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS count FROM square_credentials WHERE business_id = ANY($1::text[])", [[identity.primaryId, identity.controlId]]),
    pool.query("SELECT COUNT(*)::int AS count FROM square_oauth_transactions WHERE business_id = ANY($1::text[])", [[identity.primaryId, identity.controlId]]),
    pool.query("SELECT COUNT(*)::int AS count FROM growthwise_subscriptions WHERE business_id = ANY($1::text[])", [[identity.primaryId, identity.controlId]]),
    pool.query("SELECT COUNT(*)::int AS count FROM growthwise_tenants WHERE business_id = ANY($1::text[])", [[identity.primaryId, identity.controlId]]),
  ]);
  const remaining = checks.reduce((sum, result) => sum + Number(result.rows[0]?.count || 0), 0);

  return json(200, {
    ok: remaining === 0,
    stage: "cleanup",
    oauth_access_token_revocation_attempted: revocation.attempted,
    oauth_access_token_revoked: revocation.success,
    database_rows_remaining: remaining,
    production_touched: false,
  });
}

async function browserAction(request, url) {
  const fetchSite = request.headers.get("sec-fetch-site");
  const requestOrigin = request.headers.get("origin");
  if (url.origin !== PREVIEW_ORIGIN
    || url.pathname !== PATH
    || url.search
    || url.hash
    || (requestOrigin !== null && requestOrigin !== url.origin)
    || (fetchSite !== null && fetchSite !== "same-origin")
    || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
      !== "application/json") {
    return null;
  }

  let body;
  try { body = await request.json(); }
  catch { return ""; }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length !== 1
    || !["start", "status", "cleanup"].includes(body.action)) {
    return "";
  }
  return body.action;
}

async function browserStart(pool, identity) {
  const response = await startAcceptance(pool, identity);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok !== true || typeof body.authorization_url !== "string") {
    return html(500, "Square test could not start", [
      body.error || "Preview acceptance setup failed.",
    ], "fail");
  }
  return redirect(body.authorization_url);
}

async function browserFinish(pool, identity) {
  const resultResponse = await statusAcceptance(pool, identity);
  const result = await resultResponse.json().catch(() => ({}));

  if (result.stage !== "authorized") {
    if (result.transaction_status === "consumed_denied") {
      await cleanupAcceptance(pool, identity);
      return html(200, "Square authorization cancelled", [
        "No Square connection was kept.",
        "Disposable Preview test data was cleaned up.",
      ], "neutral");
    }
    if (result.transaction_status === "consumed_failed") {
      await cleanupAcceptance(pool, identity);
      return html(200, "Square authorization needs attention", [
        "Square returned to GrowthWise, but the connection did not complete.",
        "Disposable Preview test data was cleaned up.",
      ], "fail");
    }
    return html(409, "Square test is not finished yet", [
      "The Preview test has not received a completed Square authorization yet.",
    ], "neutral");
  }

  const cleanupResponse = await cleanupAcceptance(pool, identity);
  const cleanup = await cleanupResponse.json().catch(() => ({}));
  const passed = result.ok === true && cleanup.ok === true;

  return html(200, passed
    ? "PASS — Square tenant acceptance completed"
    : "Square acceptance checks failed", [
      "Inventory endpoint: " + result.inventory_endpoint_status,
      "Sales endpoint: " + result.sales_endpoint_status,
      "Cross-tenant request: " + result.cross_tenant_request_status + " (expected 401)",
      "Control tenant inventory: " + result.control_tenant_inventory_status + " (expected 409)",
      "Control tenant credential present: " + result.control_tenant_has_square_credential,
      "Required scopes present: " + result.required_scopes_present,
      "Inventory items observed: " + (result.inventory_item_count ?? "n/a"),
      "Completed orders (30d): " + (result.completed_order_count_30d ?? "n/a"),
      "Test token revocation attempted: " + cleanup.oauth_access_token_revocation_attempted,
      "Test token revoked: " + cleanup.oauth_access_token_revoked,
      "Database rows remaining: " + cleanup.database_rows_remaining,
      "Production touched: false",
    ], passed ? "pass" : "fail");
}

export default async function handler(request) {
  let url;
  try { url = new URL(request.url); }
  catch { return json(400, { error: "Invalid request." }); }

  const configuredKey = previewAcceptanceKey();
  if (!configuredKey) return json(404, { error: "Not found." });

  const identity = ids(configuredKey);
  const pool = getDatabase().pool;

  if (request.method === "GET"
    && url.origin === PREVIEW_ORIGIN
    && url.pathname === PATH
    && !url.hash
    && [...url.searchParams].length === 1
    && url.searchParams.getAll("browser").length === 1) {
    const browser = url.searchParams.get("browser");
    try {
      if (browser === "start") return await browserStart(pool, identity);
      if (browser === "finish") return await browserFinish(pool, identity);
    } catch {
      return html(500, "Square acceptance failed", [
        "Preview #16 could not complete the acceptance test.",
      ], "fail");
    }
    return json(404, { error: "Not found." });
  }

  let action = "";
  if (request.method === "POST") {
    const browser = await browserAction(request, url);
    if (browser === null) return json(404, { error: "Not found." });
    if (!browser) return json(400, { error: "Invalid action." });
    action = browser;
  } else if (request.method === "GET") {
    if (url.origin !== PREVIEW_ORIGIN
      || url.pathname !== PATH
      || url.hash
      || [...url.searchParams].some(([key]) => !["action", "key"].includes(key))
      || url.searchParams.getAll("action").length !== 1
      || url.searchParams.getAll("key").length !== 1
      || !safeEqual(url.searchParams.get("key") || "", configuredKey)) {
      return json(404, { error: "Not found." });
    }
    action = url.searchParams.get("action") || "";
    if (!["start", "status", "cleanup"].includes(action)) {
      return json(400, { error: "Invalid action." });
    }
  } else {
    return json(405, { error: "Method not allowed." });
  }

  try {
    if (action === "start") return await startAcceptance(pool, identity);
    if (action === "status") return await statusAcceptance(pool, identity);
    return await cleanupAcceptance(pool, identity);
  } catch {
    return json(500, {
      ok: false,
      stage: action,
      error: "Preview 16 Square acceptance failed.",
      production_touched: false,
    });
  }
}
