import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  bootstrapConnectorInvitation,
  connectorInvitationAllowsPageStart,
  createCustomerConnectorController,
  normalizeWebsiteFormUrl,
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
    assert.equal(result.attempted, true);
    assert.match(result.error, /invalid or expired/i);
    assert.equal(connectorInvitationAllowsPageStart(result), false);
    assert.deepEqual(order, ["history"]);
  }
});

test("failed invitation exchange cannot fall through to an older connector session", async () => {
  const result = await bootstrapConnectorInvitation({
    href: `${ORIGIN}/connect-accounts.html#invite=${INVITATION}`,
    historyImpl: { replaceState() {} },
    fetchImpl: async () => response({ error: "expired" }, 401),
  });
  assert.deepEqual(result, {
    exchanged: false,
    attempted: true,
    error: "Invitation is invalid or expired.",
  });
  assert.equal(connectorInvitationAllowsPageStart(result), false);
  assert.equal(connectorInvitationAllowsPageStart({ exchanged: false, attempted: false }), true);
  assert.equal(connectorInvitationAllowsPageStart({ exchanged: true, attempted: true }), true);
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
  assert.equal(state.facebook.state, "Setup unavailable");
  assert.equal(state.facebook.available, false);
  assert.equal(state.facebook.allowed, true);
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

test("Facebook remains disabled when the server reports setup unavailable", async () => {
  const controller = createCustomerConnectorController({
    fetchImpl: async (url) => url.endsWith("/connector-session") ? response({
      business_id: "dexters-hats", business_name: "Dexter's Hats",
      connectors: { facebook: { allowed: true, available: false, state: "Setup unavailable" }, instagram: { allowed: false, available: false }, email: { allowed: false, available: false, state: "Setup unavailable" } },
    }) : response({}),
  });
  const state = await controller.load();
  assert.equal(state.facebook.state, "Setup unavailable");
  assert.equal(state.facebook.available, false);
  assert.equal(Object.hasOwn(controller, "connectFacebook"), true);
  assert.equal(await controller.connectFacebook(), false);
});

test("available Facebook connector loads Page health and starts tenant-bound Meta OAuth", async () => {
  const calls = [];
  let navigated = null;
  const controller = createCustomerConnectorController({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "tierney-town-treats",
        business_name: "Tierney Town Treats",
        connectors: {
          facebook: { allowed: true, available: true, state: "Not Connected" },
          instagram: { allowed: false, available: false },
          email: { allowed: false, available: false, state: "Setup unavailable" },
        },
      });
      if (url.includes("/facebook-connection?")) return response({
        business_id: "tierney-town-treats",
        state: "Not Connected",
        checked_at: "2026-09-27T02:00:00.000Z",
        action: "Connect the Facebook Page used by this business.",
      });
      if (url.endsWith("/facebook-oauth-start")) return response({
        authorization_url: "https://www.facebook.com/v26.0/dialog/oauth?state=opaque",
      });
      return response({});
    },
    navigate: (url) => { navigated = url; },
  });
  const state = await controller.load();
  assert.equal(state.facebook.state, "Not Connected");
  assert.equal(state.facebook.allowed, true);
  assert.equal(state.facebook.available, true);
  assert.equal(await controller.connectFacebook(), true);
  const start = calls.find((call) => call.url.endsWith("/facebook-oauth-start"));
  assert.deepEqual(JSON.parse(start.init.body), { business_id: "tierney-town-treats" });
  assert.equal(navigated, "https://www.facebook.com/v26.0/dialog/oauth?state=opaque");
});

test("the static page is no-store, self-contained, credential-free, and contains safe account slots", async () => {
  const html = await readFile(new URL("../../connect-accounts.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../../assets/connector-invitation.mjs", import.meta.url), "utf8");
  const headers = await readFile(new URL("../../_headers", import.meta.url), "utf8");
  assert.match(html, /Connect your accounts/);
  assert.match(html, /id="business-name"/);
  assert.match(html, /id="instagram-card"[^>]*hidden/);
  assert.match(html, /id="instagram-status"/);
  assert.match(html, /id="email-card"[^>]*hidden/);
  assert.match(html, /id="facebook-card"[^>]*hidden/);
  assert.match(html, /id="facebook-status"/);
  assert.match(html, /id="website-card"[^>]*hidden/);
  assert.match(html, /Connect Facebook/);
  assert.match(html, /Facebook Page/);
  assert.match(html, /id="facebook-page-picker"/);
  assert.match(html, /id="facebook-page-choice"/);
  assert.match(html, /id="website-status"/);
  assert.match(html, /id="website-create"/);
  assert.match(html, /id="website-form-link"/);
  assert.match(html, /Website inquiries/);
  assert.match(html, /private to the current business/i);
  assert.doesNotMatch(html, /Coming later|Setup unavailable/);
  assert.match(script, /emailCard\.hidden = !view\.loading && !view\.email\.available/);
  assert.match(script, /facebookCard\.hidden = !view\.loading && !view\.facebook\.available/);
  assert.match(script, /instagramCard\.hidden = !view\.loading && !view\.instagram\.allowed/);
  assert.match(script, /websiteCard\.hidden = !view\.loading && !view\.website\.available/);
  assert.match(html, /Referrer-Policy/i);
  assert.match(html, /Cache-Control/i);
  assert.match(html, /Content-Security-Policy/i);
  assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/);
  assert.doesNotMatch(html, /analytics|pixel|tagmanager|admin.?key|tenant.?key|localStorage|sessionStorage|console\./i);
  assert.match(headers, /\/connect-accounts\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /Referrer-Policy: no-referrer/);
});


test("website form setup is tenant-session bound and returns only a same-origin hosted form link", async () => {
  const calls = [];
  const controller = createCustomerConnectorController({
    origin: ORIGIN,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "tierney-town-treats",
        business_name: "Tierney Town Treats",
        connectors: {
          facebook: { allowed: false, available: false, state: "Setup unavailable" },
          instagram: { allowed: false, available: false },
          email: { allowed: false, available: false, state: "Setup unavailable" },
          website: { allowed: true, available: true, state: "Not Connected" },
        },
      });
      if (url.endsWith("/website-form-config") && init.method === "GET") return response({
        business_id: "tierney-town-treats",
        state: "Not Connected",
        form_url: null,
        action: "Create a hosted contact form link for this business.",
      });
      if (url.endsWith("/website-form-config") && init.method === "POST") return response({
        ok: true,
        business_id: "tierney-town-treats",
        state: "Connected",
        form_url: ORIGIN + "/website-contact.html#form=gwf_" + "A".repeat(22),
        action: "Website inquiries will flow into this business's Narleo inbox.",
      });
      if (url.endsWith("/website-form-config") && init.method === "DELETE") return response({
        ok: true,
        business_id: "tierney-town-treats",
        state: "Not Connected",
      });
      return response({});
    },
  });

  const state = await controller.load();
  assert.equal(state.website.state, "Not Connected");
  assert.equal(state.website.allowed, true);
  assert.equal(await controller.createWebsiteForm(), true);
  assert.equal(
    controller.getState().website.formUrl,
    ORIGIN + "/website-contact.html#form=gwf_" + "A".repeat(22),
  );
  assert.equal(await controller.disconnectWebsiteForm(), true);
  assert.equal(controller.getState().website.state, "Not Connected");
  assert.equal(controller.getState().website.formUrl, "");
  assert.equal(calls.some((call) => call.url.endsWith("/website-form-config")
    && call.init.method === "POST"), true);
  assert.equal(calls.some((call) => call.url.endsWith("/website-form-config")
    && call.init.method === "DELETE"), true);
});

test("website form URL validation rejects cross-origin and malformed destinations", () => {
  const valid = ORIGIN + "/website-contact.html#form=gwf_" + "B".repeat(22);
  assert.equal(normalizeWebsiteFormUrl(valid, ORIGIN), valid);
  assert.equal(normalizeWebsiteFormUrl(
    "https://evil.example/website-contact.html#form=gwf_" + "B".repeat(22),
    ORIGIN,
  ), "");
  assert.equal(normalizeWebsiteFormUrl(ORIGIN + "/app.html#form=gwf_" + "B".repeat(22), ORIGIN), "");
  assert.equal(normalizeWebsiteFormUrl(ORIGIN + "/website-contact.html?x=1#form=gwf_" + "B".repeat(22), ORIGIN), "");
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
      if (url.includes("/microsoft-mail-connection?")) return response({
        business_id: "dexters-hats",
        state: "Not Connected",
        checked_at: "2026-09-23T19:00:00.000Z",
        action: "Connect a Microsoft business mailbox to receive email leads.",
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
    fetchImpl: async (url) => {
      if (url.endsWith("/connector-session")) return response({
        business_id: "dexters-hats", business_name: "Dexter's Hats",
        connectors: {
          facebook: { allowed: false, available: false, state: "Setup unavailable" },
          instagram: { allowed: false, available: false },
          email: { allowed: true, available: true, state: "Not Connected" },
        },
      });
      if (url.includes("/microsoft-mail-connection?")) return response({
        business_id: "dexters-hats",
        state: "Not Connected",
        checked_at: "2026-09-23T19:00:00.000Z",
        action: "Connect a Microsoft business mailbox to receive email leads.",
      });
      return response({});
    },
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


test("Facebook Page selection fragment is consumed locally before network use", async () => {
  const module = await import("../../assets/connector-invitation.mjs");
  const token = `gw_fbsel_${"V".repeat(43)}`;
  const changes = [];
  const result = module.consumeFacebookSelectionToken({
    href: `${ORIGIN}/connect-accounts.html?facebook=select#facebook_selection=${token}`,
    historyImpl: { replaceState(_a, _b, value) { changes.push(value); } },
  });
  assert.equal(result, token);
  assert.deepEqual(changes, ["/connect-accounts.html?facebook=select"]);
});

test("Facebook Page picker returns only the selected Page through the tenant-bound controller", async () => {
  const calls = [];
  const token = `gw_fbsel_${"W".repeat(43)}`;
  const controller = createCustomerConnectorController({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "tierney-town-treats",
        business_name: "Tierney Town Treats",
        connectors: {
          facebook: { allowed: true, available: true, state: "Not Connected" },
          instagram: { allowed: false, available: false },
          email: { allowed: false, available: false, state: "Setup unavailable" },
        },
      });
      if (url.includes("/facebook-connection?")) return response({
        business_id: "tierney-town-treats",
        state: "Not Connected",
        checked_at: "now",
        action: "Connect",
      });
      if (url.endsWith("/facebook-page-options")) return response({
        business_id: "tierney-town-treats",
        pages: [{ id: "page-1", name: "One" }, { id: "page-2", name: "Two" }],
        expires_at: "2026-09-27T02:10:00.000Z",
      });
      if (url.endsWith("/facebook-page-select")) return response({
        ok: true,
        business_id: "tierney-town-treats",
        account: { page_name: "Two" },
      });
      return response({});
    },
  });
  await controller.load();
  assert.equal(await controller.loadFacebookPageOptions(token), true);
  assert.equal(controller.getState().facebook.state, "Choose Page");
  assert.equal(await controller.selectFacebookPage("page-2"), true);
  assert.equal(controller.getState().facebook.state, "Connected");
  assert.equal(controller.getState().facebook.account.pageName, "Two");
  const select = calls.find((call) => call.url.endsWith("/facebook-page-select"));
  assert.deepEqual(JSON.parse(select.init.body), {
    page_id: "page-2",
    selection_token: token,
  });
});

test("email return hint is removed locally before the connector page continues", async () => {
  const module = await import("../../assets/connector-invitation.mjs");
  const changes = [];
  const hint = module.consumeEmailReturnHint({
    href: `${ORIGIN}/connect-accounts.html?email=connected&keep=1`,
    historyImpl: { replaceState(_a, _b, value) { changes.push(value); } },
  });
  assert.equal(hint, "connected");
  assert.deepEqual(changes, ["/connect-accounts.html?keep=1"]);
});

test("available email connector reads tenant-bound health before showing connected state", async () => {
  const controller = createCustomerConnectorController({
    fetchImpl: async (url) => {
      if (url.endsWith("/connector-session")) return response({
        business_id: "dexters-hats",
        business_name: "Dexter's Hats",
        connectors: {
          facebook: { allowed: false, available: false, state: "Setup unavailable" },
          instagram: { allowed: false, available: false },
          email: { allowed: true, available: true, state: "Not Connected" },
        },
      });
      if (url.includes("/microsoft-mail-connection?")) return response({
        business_id: "dexters-hats",
        state: "Connected",
        checked_at: "2026-09-23T19:00:00.000Z",
        account: { address: "dexter@hotmail.com", display_name: "Dexter" },
        action: "",
      });
      return response({});
    },
  });

  const state = await controller.load();
  assert.equal(state.email.state, "Connected");
  assert.equal(state.email.account.address, "dexter@hotmail.com");
});

test("email disconnect posts only the session tenant and clears local connected state", async () => {
  const calls = [];
  const controller = createCustomerConnectorController({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/connector-session")) return response({
        business_id: "dexters-hats",
        business_name: "Dexter's Hats",
        connectors: {
          facebook: { allowed: false, available: false, state: "Setup unavailable" },
          instagram: { allowed: false, available: false },
          email: { allowed: true, available: true, state: "Not Connected" },
        },
      });
      if (url.includes("/microsoft-mail-connection?")) return response({
        business_id: "dexters-hats",
        state: "Connected",
        checked_at: "2026-09-23T19:00:00.000Z",
        account: { address: "dexter@hotmail.com", display_name: "Dexter" },
        action: "",
      });
      if (url.endsWith("/microsoft-mail-disconnect")) return response({ ok: true });
      return response({});
    },
  });

  await controller.load();
  assert.equal(await controller.disconnectEmail(), true);
  const call = calls.find((entry) => entry.url.endsWith("/microsoft-mail-disconnect"));
  assert.deepEqual(JSON.parse(call.init.body), { business_id: "dexters-hats" });
  assert.equal(controller.getState().email.state, "Not Connected");
});
