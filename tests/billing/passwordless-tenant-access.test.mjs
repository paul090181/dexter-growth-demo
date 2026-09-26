import assert from "node:assert/strict";
import test from "node:test";

import {
  TENANT_SESSION_COOKIE,
  authorizeTenantRequest,
  hashTenantLoginToken,
  hashTenantSessionToken,
} from "../../netlify/functions/_tenant-auth.mjs";
import { createTenantLoginRequestHandler } from "../../netlify/functions/tenant-login-request.mjs";
import { createTenantLoginExchangeHandler } from "../../netlify/functions/tenant-login-exchange.mjs";
import { createTenantSessionHandler } from "../../netlify/functions/tenant-session.mjs";
import { createTenantSessionLogoutHandler } from "../../netlify/functions/tenant-session-logout.mjs";
import {
  consumeMagicToken,
  exchangeMagicToken,
} from "../../assets/tenant-signin.mjs";

const ORIGIN = "https://deploy-preview-17--growthwise.example";
const BUSINESS_ID = "north-star-books-abcdef123456";
const NOW = new Date("2026-09-26T01:30:00.000Z");

function post(path, body, headers = {}) {
  return new Request(`${ORIGIN}/.netlify/functions/${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("passwordless request does not reveal whether an email has a workspace", async () => {
  const writes = [];
  const sends = [];
  const store = {
    async listTenantsByEmail({ email }) {
      return email === "jamie@example.com"
        ? [{
            business_id: BUSINESS_ID,
            business_name: "North Star Books",
            contact_name: "Jamie",
            contact_email: email,
          }]
        : [];
    },
    async createLoginToken(input) {
      writes.push(input);
      return input;
    },
  };
  const handler = createTenantLoginRequestHandler({
    store,
    emailConfig: () => ({ provider: "resend", apiKey: "secret", from: "GrowthWise <login@example.com>" }),
    sendEmail: async (input) => { sends.push(input); return true; },
    publicOrigin: () => ORIGIN,
    now: () => NOW,
  });

  const known = await handler(post("tenant-login-request", { email: "jamie@example.com" }));
  const unknown = await handler(post("tenant-login-request", { email: "nobody@example.com" }));
  const knownBody = await known.json();
  const unknownBody = await unknown.json();

  assert.equal(known.status, 200);
  assert.equal(unknown.status, 200);
  assert.deepEqual(knownBody, unknownBody);
  assert.equal(sends.length, 1);
  assert.equal(writes.length, 1);
  assert.match(writes[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(writes[0].businessId, BUSINESS_ID);
  assert.equal(writes[0].expiresAt.toISOString(), "2026-09-26T01:45:00.000Z");

  const magicUrl = new URL(sends[0].links[0].url);
  assert.equal(magicUrl.origin, ORIGIN);
  assert.equal(magicUrl.pathname, "/signin.html");
  assert.equal(magicUrl.search, "");
  assert.match(magicUrl.hash, /^#token=gw_login_[A-Za-z0-9_-]{43}$/);
  const raw = magicUrl.hash.slice("#token=".length);
  assert.equal(hashTenantLoginToken(raw), writes[0].tokenHash);
  assert.equal(JSON.stringify(writes).includes(raw), false);
  assert.equal(JSON.stringify(knownBody).includes(raw), false);
});

test("passwordless request reports global preview configuration without account lookup", async () => {
  let reads = 0;
  const handler = createTenantLoginRequestHandler({
    store: { async listTenantsByEmail() { reads += 1; return []; } },
    emailConfig: () => null,
    publicOrigin: () => ORIGIN,
  });
  const response = await handler(post("tenant-login-request", { email: "jamie@example.com" }));
  assert.equal(response.status, 503);
  assert.equal(reads, 0);
  assert.match((await response.json()).error, /not configured/i);
});

test("magic-link exchange creates a fixed secure HttpOnly session cookie and returns no token", async () => {
  let redeemInput;
  const rawLogin = `gw_login_${"A".repeat(43)}`;
  const handler = createTenantLoginExchangeHandler({
    publicOrigin: () => ORIGIN,
    now: () => NOW,
    store: {
      async redeemLoginToken(input) {
        redeemInput = input;
        return {
          business_id: BUSINESS_ID,
          expires_at: input.sessionExpiresAt,
        };
      },
    },
  });

  const response = await handler(post("tenant-login-exchange", { token: rawLogin }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ok: true,
    business_id: BUSINESS_ID,
    expires_at: "2026-10-26T01:30:00.000Z",
  });
  assert.equal(redeemInput.tokenHash, hashTenantLoginToken(rawLogin));
  assert.match(redeemInput.sessionHash, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(body).includes(rawLogin), false);

  const cookie = response.headers.get("set-cookie") || "";
  assert.match(cookie, new RegExp(`^${TENANT_SESSION_COOKIE}=gw_tsession_[A-Za-z0-9_-]{43};`));
  assert.match(cookie, /Max-Age=2592000/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(cookie.includes("Domain="), false);
});

test("tenant session cookie authorizes only its bound business", async () => {
  const rawSession = `gw_tsession_${"B".repeat(43)}`;
  const store = {
    async authorizeTenantSession({ sessionHash, businessId }) {
      assert.equal(sessionHash, hashTenantSessionToken(rawSession));
      if (businessId && businessId !== BUSINESS_ID) throw new Error("SESSION_INVALID");
      return { business_id: BUSINESS_ID, expires_at: new Date("2026-10-26T01:30:00.000Z") };
    },
  };
  const request = new Request(`${ORIGIN}/x`, {
    headers: { cookie: `${TENANT_SESSION_COOKIE}=${rawSession}` },
  });

  const ok = await authorizeTenantRequest(request, { businessId: BUSINESS_ID, store, now: NOW });
  const wrong = await authorizeTenantRequest(request, { businessId: "other-business-abcdef123456", store, now: NOW });
  assert.deepEqual(ok, { ok: true, via: "tenant_session", businessId: BUSINESS_ID });
  assert.equal(wrong.ok, false);
});

test("tenant session metadata and logout never expose the raw cookie token", async () => {
  const rawSession = `gw_tsession_${"C".repeat(43)}`;
  const cookie = `${TENANT_SESSION_COOKIE}=${rawSession}`;
  const store = {
    async authorizeTenantSession({ sessionHash }) {
      assert.equal(sessionHash, hashTenantSessionToken(rawSession));
      return { business_id: BUSINESS_ID, expires_at: new Date("2026-10-26T01:30:00.000Z") };
    },
    async revokeTenantSession({ sessionHash }) {
      assert.equal(sessionHash, hashTenantSessionToken(rawSession));
      return { session_hash: sessionHash };
    },
  };

  const sessionHandler = createTenantSessionHandler({ store, now: () => NOW });
  const sessionResponse = await sessionHandler(new Request(
    `${ORIGIN}/.netlify/functions/tenant-session`,
    { headers: { cookie } },
  ));
  const sessionBody = await sessionResponse.json();
  assert.equal(sessionResponse.status, 200);
  assert.equal(sessionBody.business_id, BUSINESS_ID);
  assert.equal(JSON.stringify(sessionBody).includes(rawSession), false);

  const logout = createTenantSessionLogoutHandler({
    store,
    publicOrigin: () => ORIGIN,
    now: () => NOW,
  });
  const logoutResponse = await logout(new Request(
    `${ORIGIN}/.netlify/functions/tenant-session-logout`,
    { method: "POST", headers: { cookie, origin: ORIGIN } },
  ));
  assert.equal(logoutResponse.status, 200);
  assert.match(logoutResponse.headers.get("set-cookie") || "", /Max-Age=0/);
});

test("browser consumes the fragment before exchange and sends token only in POST body", async () => {
  const raw = `gw_login_${"D".repeat(43)}`;
  let replaced = "";
  const token = consumeMagicToken({
    href: `${ORIGIN}/signin.html#token=${raw}`,
    historyImpl: { replaceState(_a, _b, value) { replaced = value; } },
  });
  assert.equal(token, raw);
  assert.equal(replaced, "/signin.html");

  let request;
  const result = await exchangeMagicToken({
    token,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true, business_id: BUSINESS_ID }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(request.url, "/.netlify/functions/tenant-login-exchange");
  assert.equal(request.url.includes(raw), false);
  assert.deepEqual(JSON.parse(request.init.body), { token: raw });
});
