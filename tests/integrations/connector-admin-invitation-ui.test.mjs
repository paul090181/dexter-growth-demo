import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  createGrowthWiseDevEmailInvitationController,
  createGrowthWiseDevFacebookInvitationController,
  createDexterPilotInvitationController,
  mountGrowthWiseDevFacebookInvitation,
} from "../../assets/admin-connector-invitation.mjs";

const ORIGIN = "https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app";
const INVITE = `${ORIGIN}/connect-accounts.html#invite=gw_inv_${"A".repeat(43)}`;

function storageWith(value = "saved-admin-key") {
  const values = new Map(value ? [["growthwise_admin_key", value]] : []);
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, next) { values.set(key, String(next)); },
    removeItem(key) { values.delete(key); },
  };
}

test("admin invitation control creates only growthwise-dev email invitation and opens it", async () => {
  const calls = [];
  const navigated = [];
  const states = [];
  const storage = storageWith();

  const controller = createGrowthWiseDevEmailInvitationController({
    origin: ORIGIN,
    storage,
    onState: (state) => states.push(state),
    navigate: (url) => navigated.push(url),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        business_id: "growthwise-dev",
        connectors: ["email"],
        expires_at: "2026-09-24T20:00:00.000Z",
        invitation_url: INVITE,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(controller.hasAdminKey(), true);
  assert.equal(await controller.createAndOpen(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/connector-invitation-create");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-GrowthWise-Key"], "saved-admin-key");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    business_id: "growthwise-dev",
    connectors: ["email"],
  });
  assert.deepEqual(navigated, [INVITE]);
  assert.equal(states.some((state) => JSON.stringify(state).includes("gw_inv_")), false);
});

test("Facebook acceptance control creates only a growthwise-dev Facebook invitation and opens it", async () => {
  const calls = [];
  const navigated = [];
  const states = [];

  const controller = createGrowthWiseDevFacebookInvitationController({
    origin: ORIGIN,
    storage: storageWith(),
    onState: (state) => states.push(state),
    navigate: (url) => navigated.push(url),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        business_id: "growthwise-dev",
        connectors: ["facebook"],
        expires_at: "2026-09-27T20:00:00.000Z",
        invitation_url: INVITE,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(controller.hasAdminKey(), true);
  assert.equal(await controller.createAndOpen(), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/connector-invitation-create");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    business_id: "growthwise-dev",
    connectors: ["facebook"],
  });
  assert.deepEqual(navigated, [INVITE]);
  assert.equal(states.some((state) => JSON.stringify(state).includes("gw_inv_")), false);
});

test("Facebook acceptance card mounts behind the admin unlock and opens its secure invitation", async () => {
  const handlers = new Map();
  const calls = [];
  const navigated = [];
  const classes = new Set(["hidden"]);
  const card = {
    classList: {
      toggle(name, force) { force ? classes.add(name) : classes.delete(name); },
    },
  };
  const button = {
    disabled: false,
    addEventListener(name, handler) { handlers.set(name, handler); },
  };
  const status = {
    className: "create-status hidden",
    classList: { add() {} },
    textContent: "",
  };
  const elements = new Map([
    ["facebookAcceptanceOperator", card],
    ["createFacebookAcceptanceInvitationBtn", button],
    ["facebookAcceptanceOperatorStatus", status],
  ]);
  const windowImpl = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        business_id: "growthwise-dev",
        connectors: ["facebook"],
        invitation_url: INVITE,
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
    sessionStorage: storageWith(),
    location: { origin: ORIGIN, assign: (url) => navigated.push(url) },
    addEventListener() {},
  };

  const controller = mountGrowthWiseDevFacebookInvitation({
    documentImpl: { getElementById: (id) => elements.get(id) ?? null },
    windowImpl,
  });

  assert.ok(controller);
  assert.equal(classes.has("hidden"), false);
  await handlers.get("click")();
  assert.equal(button.disabled, false);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    business_id: "growthwise-dev",
    connectors: ["facebook"],
  });
  assert.deepEqual(navigated, [INVITE]);
});

test("Dexter pilot activity controller reads only the admin-gated summary endpoint", async () => {
  const calls = [];
  const states = [];
  const controller = createDexterPilotInvitationController({
    origin: ORIGIN,
    storage: storageWith(),
    onActivity: (state) => states.push(state),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ok: true,
        business_id: "dexters-hats",
        stage: "draft_ready",
        stage_label: "Dexter created an Instagram draft",
        invitation: { state: "opened" },
        session: { state: "active" },
        activity: {
          counts: {
            pilot_opened: 1,
            instagram_photo_selected: 1,
            instagram_draft_created: 1,
            instagram_publish_succeeded: 0,
            instagram_publish_failed: 0,
            feedback_submitted: 0,
          },
          first_opened_at: "2026-09-27T14:16:00.000Z",
          last_activity_at: "2026-09-27T14:22:00.000Z",
          last_event: "instagram_draft_created",
          total_events: 3,
        },
        feedback: {
          total: 0,
          worked: 0,
          needs_improvement: 0,
          last_result: null,
          last_at: null,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const body = await controller.loadStatus();
  assert.equal(body.stage, "draft_ready");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/.netlify/functions/dexter-pilot-status");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["X-GrowthWise-Key"], "saved-admin-key");
  assert.equal(states.at(-1).data.business_id, "dexters-hats");
});

test("Dexter pilot activity controller clears a stale admin key on 401", async () => {
  const storage = storageWith();
  const states = [];
  const controller = createDexterPilotInvitationController({
    origin: ORIGIN,
    storage,
    onActivity: (state) => states.push(state),
    fetchImpl: async () => new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(await controller.loadStatus(), null);
  assert.equal(storage.getItem("growthwise_admin_key"), null);
  assert.equal(states.at(-1).status, "locked");
});

test("admin invitation control refuses mismatched tenant or connector response", async () => {
  for (const body of [
    { business_id: "dexters-hats", connectors: ["email"], invitation_url: INVITE },
    { business_id: "growthwise-dev", connectors: ["email", "instagram"], invitation_url: INVITE },
  ]) {
    let navigated = false;
    const controller = createGrowthWiseDevEmailInvitationController({
      origin: ORIGIN,
      storage: storageWith(),
      navigate: () => { navigated = true; },
      fetchImpl: async () => new Response(JSON.stringify(body), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    assert.equal(await controller.createAndOpen(), false);
    assert.equal(navigated, false);
  }
});

test("admin invitation control rejects cross-origin or malformed invitation URL", async () => {
  for (const invitation_url of [
    `https://evil.example/connect-accounts.html#invite=gw_inv_${"A".repeat(43)}`,
    `${ORIGIN}/connect-accounts.html?leak=1#invite=gw_inv_${"A".repeat(43)}`,
    `${ORIGIN}/connect-accounts.html#invite=not-a-token`,
  ]) {
    let navigated = false;
    const controller = createGrowthWiseDevEmailInvitationController({
      origin: ORIGIN,
      storage: storageWith(),
      navigate: () => { navigated = true; },
      fetchImpl: async () => new Response(JSON.stringify({
        business_id: "growthwise-dev",
        connectors: ["email"],
        invitation_url,
      }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    });

    assert.equal(await controller.createAndOpen(), false);
    assert.equal(navigated, false);
  }
});

test("401 removes stale admin key and never navigates", async () => {
  const storage = storageWith();
  let navigated = false;
  const controller = createGrowthWiseDevEmailInvitationController({
    origin: ORIGIN,
    storage,
    navigate: () => { navigated = true; },
    fetchImpl: async () => new Response(JSON.stringify({ error: "Unauthorized." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }),
  });

  assert.equal(await controller.createAndOpen(), false);
  assert.equal(storage.getItem("growthwise_admin_key"), null);
  assert.equal(navigated, false);
});

test("operator UI is admin-gated and keeps acceptance controls fixed to growthwise-dev", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /id="emailAcceptanceOperator"[^>]*class="operator-card hidden"|class="operator-card hidden" id="emailAcceptanceOperator"/);
  assert.match(html, /growthwise-dev · email only/);
  assert.match(html, /id="facebookAcceptanceOperator"[^>]*class="operator-card hidden"|class="operator-card hidden" id="facebookAcceptanceOperator"/);
  assert.match(html, /growthwise-dev · facebook only/);
  assert.match(html, /cannot target Dexter’s Hats/);
  assert.match(html, /id="dexterPilotOperator"/);
  assert.match(html, /id="loadDexterPilotActivityBtn"/);
  assert.match(html, /id="dexterPilotActivityDetails"/);
  assert.match(html, /id="dexterPilotActivityStage"/);
  assert.match(html, /id="dexterPilotActivityTimeline"/);
  assert.match(html, /id="dexterPilotActivityFeedback"/);
  assert.match(html, /assets\/admin-connector-invitation\.mjs/);
  assert.doesNotMatch(html, /id="emailAcceptanceInvitationUrl"/);
  assert.doesNotMatch(html, /id="facebookAcceptanceInvitationUrl"/);
});
