import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bootstrapConnectorInvitation,
  createCustomerConnectorController,
} from "../../assets/connector-invitation.mjs";

const ORIGIN = "https://preview.example";
const INVITATION = `gw_inv_${"A".repeat(43)}`;

function response(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("bootstrap removes the invitation fragment before its first network request", async () => {
  const order = [];
  const history = { replaceState(_state, _title, value) { order.push(["history", value]); } };
  const fetchImpl = async (url, init) => {
    order.push(["fetch", url, init]);
    return response({ business_id: "dexters-hats", expires_at: "2026-09-23T12:30:00.000Z" });
  };
  const result = await bootstrapConnectorInvitation({
    href: `${ORIGIN}/connect-accounts.html#invite=${INVITATION}`, historyImpl: history, fetchImpl,
  });
  assert.equal(result.exchanged, true);
  assert.equal(order[0][0], "history");
  assert.equal(order[0][1], "/connect-accounts.html");
  assert.equal(order[1][0], "fetch");
  assert.equal(order[1][1], "/.netlify/functions/connector-invitation-exchange");
  assert.deepEqual(JSON.parse(order[1][2].body), { invitation_token: INVITATION });
  assert.equal(JSON.stringify(order).includes("#invite="), false);
});

test("malformed or extra fragment fields are removed and never sent", async () => {
  for (const hash of ["#invite=bad", `#invite=${INVITATION}&next=evil`, "#other=value"]) {
    const order = [];
    const result = await bootstrapConnectorInvitation({
      href: `${ORIGIN}/connect-accounts.html${hash}`,
      historyImpl: { replaceState() { order.push("history"); } },
      fetchImpl: async () => { order.push("fetch"); return response({}); },
    });
    assert.equal(result.exchanged, false);
    assert.deepEqual(order, ["history"]);
  }
});

test("controller loads cookie-bound session and authoritative Instagram health", async () => {
  const calls = [];
  const states = [];
  const controller = createCustomerConnectorController({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "dexters-hats", business_name: "Dexter's Hats",
        connectors: { facebook: { allowed: true, available: false, state: "Setup unavailable" }, instagram: { allowed: true, available: true }, email: { allowed: false, available: false, state: "Setup unavailable" } },
      });
      return response({ business_id: "dexters-hats", state: "Connected", checked_at: "2026-09-23T12:00:00.000Z", account: { username: "dexters.hats" } });
    },
    onChange: (state) => states.push(state),
  });
  const state = await controller.load();
  assert.equal(state.businessName, "Dexter's Hats");
  assert.equal(state.instagram.state, "Connected");
  assert.equal(state.instagram.account.username, "dexters.hats");
  assert.deepEqual(state.facebook, { state: "Setup unavailable", available: false });
  assert.equal(calls[1].url, "/.netlify/functions/instagram-connection?business_id=dexters-hats");
  assert.equal(calls.every((call) => !call.init?.headers?.["X-GrowthWise-Key"]), true);
  assert.equal(states.at(-1).businessId, "dexters-hats");
});

test("Instagram connect posts only the session tenant and navigates only to Instagram HTTPS", async () => {
  const calls = [];
  let navigated = null;
  const controller = createCustomerConnectorController({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "dexters-hats", business_name: "Dexter's Hats",
        connectors: { facebook: { allowed: true, available: false, state: "Setup unavailable" }, instagram: { allowed: true, available: true }, email: { allowed: false, available: false, state: "Setup unavailable" } },
      });
      if (url.includes("instagram-connection")) return response({ business_id: "dexters-hats", state: "Not Connected", checked_at: "now", action: "Connect" });
      return response({ authorization_url: "https://www.instagram.com/oauth/authorize?state=opaque" });
    },
    navigate: (url) => { navigated = url; },
  });
  await controller.load();
  assert.equal(await controller.connectInstagram(), true);
  const start = calls.find((call) => call.url.endsWith("/instagram-oauth-start"));
  assert.deepEqual(JSON.parse(start.init.body), { business_id: "dexters-hats" });
  assert.equal(navigated, "https://www.instagram.com/oauth/authorize?state=opaque");
});

test("Facebook remains unavailable and no connection action is exposed", async () => {
  const controller = createCustomerConnectorController({
    fetchImpl: async (url) => url.endsWith("/connector-session") ? response({
      business_id: "dexters-hats", business_name: "Dexter's Hats",
      connectors: { facebook: { allowed: true, available: false, state: "Setup unavailable" }, instagram: { allowed: false, available: false }, email: { allowed: false, available: false, state: "Setup unavailable" } },
    }) : response({}),
  });
  const state = await controller.load();
  assert.equal(state.facebook.state, "Setup unavailable");
  assert.equal(state.facebook.available, false);
  assert.equal(Object.hasOwn(controller, "connectFacebook"), false);
});

test("the static page is no-store, self-contained, credential-free, and contains safe account slots", async () => {
  const html = await readFile(new URL("../../connect-accounts.html", import.meta.url), "utf8");
  const headers = await readFile(new URL("../../_headers", import.meta.url), "utf8");
  assert.match(html, /Connect your accounts/);
  assert.match(html, /id="business-name"/);
  assert.match(html, /id="instagram-status"/);
  assert.match(html, /id="facebook-status"/);
  assert.match(html, /Facebook connection setup is not available yet\./);
  assert.match(html, /Referrer-Policy/i);
  assert.match(html, /Cache-Control/i);
  assert.match(html, /Content-Security-Policy/i);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(html, /analytics|pixel|tagmanager|admin.?key|tenant.?key|localStorage|sessionStorage|console\./i);
  assert.match(headers, /\/connect-accounts\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});


test("email connect requires explicit mailbox-context acknowledgement before OAuth start", async () => {
  const calls = [];
  let navigated = null;
  const controller = createCustomerConnectorController({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "dexters-hats", business_name: "Dexter's Hats",
        connectors: {
          facebook: { allowed: false, available: false, state: "Setup unavailable" },
          instagram: { allowed: false, available: false },
          email: { allowed: true, available: true, state: "Not Connected" },
        },
      });
      return response({ authorization_url: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=opaque" });
    },
    navigate: (url) => { navigated = url; },
  });

  await controller.load();
  assert.equal(await controller.connectEmail(), false);
  assert.equal(calls.filter((call) => call.url.endsWith("/microsoft-mail-oauth-start")).length, 0);

  controller.setEmailMailboxContext("personal_acknowledged");
  assert.equal(await controller.connectEmail(), true);
  const start = calls.find((call) => call.url.endsWith("/microsoft-mail-oauth-start"));
  assert.deepEqual(JSON.parse(start.init.body), {
    business_id: "dexters-hats",
    mailbox_context: "personal_acknowledged",
  });
  assert.equal(navigated.startsWith("https://login.microsoftonline.com/"), true);
});

test("email mailbox context rejects arbitrary values", async () => {
  const controller = createCustomerConnectorController({
    fetchImpl: async (url) => url.endsWith("/connector-session") ? response({
      business_id: "dexters-hats", business_name: "Dexter's Hats",
      connectors: {
        facebook: { allowed: false, available: false, state: "Setup unavailable" },
        instagram: { allowed: false, available: false },
        email: { allowed: true, available: true, state: "Not Connected" },
      },
    }) : response({}),
  });
  await controller.load();
  controller.setEmailMailboxContext("yes-just-do-it");
  assert.equal(controller.getState().email.mailboxContext, "");
});

test("secure account page includes business-mailbox guidance and no external email provider links", async () => {
  const html = await readFile(new URL("../../connect-accounts.html", import.meta.url), "utf8");
  assert.match(html, /This is a business mailbox\./);
  assert.match(html, /I understand this mailbox also contains personal email/i);
  assert.match(html, /business-email-help\.html/);
  assert.doesNotMatch(html, /outlook\.com|microsoft\.com\/en-us\/microsoft-365/);
});
