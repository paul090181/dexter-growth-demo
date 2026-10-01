import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const redirects = await readFile(new URL("../../_redirects", import.meta.url), "utf8");
const headers = await readFile(new URL("../../_headers", import.meta.url), "utf8");
const index = await readFile(new URL("../../index.html", import.meta.url), "utf8");
const app = await readFile(new URL("../../app.html", import.meta.url), "utf8");

test("Production root is forced to the Narleo customer workspace instead of the legacy Dexter index", () => {
  assert.match(index, /Dexter Growth Assistant/i);
  assert.match(app, /Narleo Business Workspace/i);
  assert.match(redirects, /^\/\s+\/app\.html\s+200!\s*$/m);
});

test("legacy internal and demo pages are redirected away from the Narleo Production surface", () => {
  const routes = [
    "/index.html",
    "/automotive-pilot.html",
    "/instagram-dev.html",
    "/show-growthwise.html",
  ];
  for (const route of routes) {
    const escaped = route.replaceAll("/", "\\/").replaceAll(".", "\\.");
    assert.match(
      redirects,
      new RegExp("^" + escaped + "\\s+/app\\.html\\s+302!\\s*$", "m"),
    );
  }
});

test("root and signup surfaces receive no-store, no-referrer, and frame protection", () => {
  for (const route of ["/", "/signup.html"]) {
    const escaped = route.replaceAll("/", "\\/").replaceAll(".", "\\.");
    const block = new RegExp(
      "^" + escaped + "\\n(?:  .+\\n)+",
      "m",
    ).exec(headers)?.[0] || "";
    assert.match(block, /Cache-Control: no-store, no-cache, must-revalidate/);
    assert.match(block, /Referrer-Policy: no-referrer/);
    assert.match(block, /X-Content-Type-Options: nosniff/);
    assert.match(block, /frame-ancestors 'none'/);
    if (route === "/signup.html") assert.match(block, /script-src 'self'/);
  }
});
