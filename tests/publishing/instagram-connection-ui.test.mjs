import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInstagramConnectionController } from "../../assets/instagram-connection.mjs";

const ok = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const controller = (overrides = {}) => createInstagramConnectionController({
  businessId: "growthwise-dev", adminKey: "synthetic-admin", fetchImpl: async () => ok({ state: "Not Connected", action: "Connect Instagram." }),
  navigate: () => {}, historyImpl: { replaceState() {} }, ...overrides,
});

test("component renders Not Connected Connect Connecting Connected and Needs Attention states", async () => {
  const seen = [];
  const c = controller({ onChange: (view) => seen.push(view), fetchImpl: async () => ok({ state: "Connected", account: { username: "safe.user", name: "ignored" } }) });
  assert.equal(c.getView().state, "Not Connected");
  await c.loadHealth();
  assert.equal(c.getView().state, "Connected");
  assert.deepEqual(c.getView().account, { username: "safe.user" });
  const failed = controller({ fetchImpl: async () => new Response("{}", { status: 503 }) });
  await failed.loadHealth();
  assert.equal(failed.getView().state, "Needs Attention");
  assert.ok(seen.some(({ loading }) => loading));
});

test("component displays only Connected to username safe identity", async () => {
  const c = controller({ fetchImpl: async () => ok({ state: "Connected", account: { username: "safe.user", name: "Private Name", account_id: "private-id" } }) });
  await c.loadHealth();
  assert.deepEqual(c.getView().account, { username: "safe.user" });
  assert.equal(JSON.stringify(c.getView()).includes("private-id"), false);
});

test("connect sends X-GrowthWise-Key and business_id to same-origin start", async () => {
  let request;
  const c = controller({ fetchImpl: async (url, init) => { request = { url, init }; return ok({ authorization_url: "https://www.instagram.com/oauth/authorize?safe=1" }); } });
  assert.equal(await c.connect(), true);
  assert.equal(request.url, "/.netlify/functions/instagram-oauth-start");
  assert.equal(request.init.headers["X-GrowthWise-Key"], "synthetic-admin");
  assert.deepEqual(JSON.parse(request.init.body), { business_id: "growthwise-dev" });
});

test("missing admin key is treated as locked setup instead of an Instagram failure", async () => {
  let requests = 0;
  const c = controller({
    adminKey: "",
    fetchImpl: async () => { requests += 1; return ok({ state: "Not Connected", action: "Connect Instagram." }); },
  });
  await c.loadHealth();
  assert.equal(c.getView().state, "Not Connected");
  assert.match(c.getView().action, /GrowthWise access key/i);
  assert.equal(await c.connect(), false);
  assert.equal(requests, 0);
});

test("start endpoint auth and rate-limit errors surface safe recovery guidance", async () => {
  const unauthorized = controller({ fetchImpl: async () => new Response(JSON.stringify({ error: "Invalid GrowthWise access code." }), { status: 401 }) });
  assert.equal(await unauthorized.connect(), false);
  assert.match(unauthorized.getView().action, /Unlock GrowthWise/i);

  const limited = controller({ fetchImpl: async () => new Response(JSON.stringify({ error: "Try connecting Instagram again later." }), { status: 429 }) });
  assert.equal(await limited.connect(), false);
  assert.match(limited.getView().action, /30 seconds/i);
});

test("simultaneous connect calls produce one start request and one navigation", async () => {
  let requests = 0;
  let navigations = 0;
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const c = controller({
    fetchImpl: async () => { requests += 1; return response; },
    navigate: () => { navigations += 1; },
  });
  const first = c.connect();
  const second = c.connect();
  assert.equal(first, second);
  assert.equal(requests, 1);
  assert.equal(c.getView().connecting, true);
  release(ok({ authorization_url: "https://www.instagram.com/oauth/authorize?safe=1" }));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(requests, 1);
  assert.equal(navigations, 1);
});

test("connect rejects non-HTTPS wrong-origin and extra-field authorization responses", async () => {
  for (const body of [
    { authorization_url: "http://www.instagram.com/oauth/authorize" },
    { authorization_url: "https://attacker.example/oauth/authorize" },
    { authorization_url: "https://www.instagram.com/oauth/authorize", extra: true },
  ]) assert.equal(await controller({ fetchImpl: async () => ok(body) }).connect(), false);
});

test("connect response never exposes or stores token code app secret or state secret", async () => {
  const c = controller({ fetchImpl: async () => ok({ authorization_url: "https://www.instagram.com/oauth/authorize", access_token: "sentinel" }) });
  await c.connect();
  assert.equal(JSON.stringify(c.getView()).includes("sentinel"), false);
});

test("return query accepts only connected cancelled and attention hints", async () => {
  for (const hint of ["connected", "cancelled", "attention"]) assert.equal(await controller().consumeReturnHint(`https://site.test/path?instagram=${hint}`), hint);
  assert.equal(await controller().consumeReturnHint("https://site.test/path?instagram=other"), null);
});

test("return query is removed immediately and never establishes Connected", async () => {
  const events = [];
  let resolveFetch;
  const c = controller({ historyImpl: { replaceState: (...args) => events.push(["replace", ...args]) }, fetchImpl: () => new Promise((resolve) => { resolveFetch = resolve; }) });
  const pending = c.consumeReturnHint("https://site.test/path?instagram=connected&keep=yes#anchor");
  assert.deepEqual(events[0], ["replace", null, "", "/path?keep=yes#anchor"]);
  assert.notEqual(c.getView().state, "Connected");
  resolveFetch(ok({ state: "Not Connected", action: "Connect" }));
  await pending;
  assert.equal(c.getView().state, "Not Connected");
});

test("both integration pages import and mount the exact same reusable component", async () => {
  for (const file of ["index.html", "instagram-dev.html"]) {
    const html = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(html, /import \{ mountInstagramConnection \} from "\.\/assets\/instagram-connection\.mjs"/);
    assert.equal((html.match(/mountInstagramConnection\s*\(/g) || []).length, 1);
  }
});

test("growthwise-dev page requests health and starts OAuth only for growthwise-dev", async () => {
  const html = await readFile(new URL("../../instagram-dev.html", import.meta.url), "utf8");
  assert.match(html, /businessId: "growthwise-dev"/); assert.doesNotMatch(html, /dexters-hats/);
});

test("Dexter page requests health and starts OAuth only for dexters-hats", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  assert.match(html, /businessId: "dexters-hats"/); assert.doesNotMatch(html, /businessId: "growthwise-dev"/);
});

test("future tenant IDs use the same controller path without tenant-specific OAuth logic", async () => {
  let body;
  const c = controller({ businessId: "future-tenant", fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return ok({ authorization_url: "https://www.instagram.com/oauth/authorize" }); } });
  await c.connect(); assert.deepEqual(body, { business_id: "future-tenant" });
});
