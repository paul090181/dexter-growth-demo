import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { resolveAutomationLevel } from "../../core/publishing/automation/policy.mjs";
import { authorizeRole } from "../../core/publishing/automation/permissions.mjs";

const loadClient = async (filename) =>
  JSON.parse(await readFile(new URL(`../../clients/${filename}`, import.meta.url), "utf8"));

test("both clients keep Facebook Marketplace manual in shadow mode", async () => {
  for (const filename of ["auto-city.json", "dexters-hats.json"]) {
    const config = await loadClient(filename);
    assert.equal(config.publishing.shadow_mode, true);
    assert.equal(config.publishing.live_actions_enabled, false);
    assert.equal(resolveAutomationLevel(config, "facebook-marketplace", "publish:create"), "manual");
  }
});

test("automation resolution uses action, channel, then business precedence", () => {
  const config = {
    publishing: {
      automation: {
        default: "review",
        channels: { website: "automatic" },
        actions: { remove: "manual" },
      },
    },
  };

  assert.equal(resolveAutomationLevel(config, "instagram", "create"), "review");
  assert.equal(resolveAutomationLevel(config, "website", "create"), "automatic");
  assert.equal(resolveAutomationLevel(config, "website", "remove"), "manual");
});

test("owner/admin has full publishing and configuration access", () => {
  for (const action of ["draft:approve", "publish:request", "publish:auto", "settings:automation", "settings:integrations"]) {
    assert.equal(authorizeRole("owner_admin", action).allowed, true);
  }
});

test("manager can approve and publish but cannot change integration secrets", () => {
  assert.equal(authorizeRole("manager", "draft:approve").allowed, true);
  assert.equal(authorizeRole("manager", "publish:request").allowed, true);
  assert.equal(authorizeRole("manager", "publish:auto").allowed, true);
  assert.equal(authorizeRole("manager", "settings:integrations").allowed, false);
});

test("staff can edit drafts but cannot approve automatic publishing", () => {
  assert.equal(authorizeRole("staff", "draft:create").allowed, true);
  assert.equal(authorizeRole("staff", "draft:edit").allowed, true);
  assert.equal(authorizeRole("staff", "draft:approve").allowed, false);
  assert.equal(authorizeRole("staff", "publish:auto").allowed, false);
});

test("view-only and unknown principals deny mutations by default", () => {
  assert.equal(authorizeRole("view_only", "analytics:view").allowed, true);
  assert.equal(authorizeRole("view_only", "draft:edit").allowed, false);
  assert.equal(authorizeRole("view_only", "publish:request").allowed, false);
  assert.equal(authorizeRole("unknown", "analytics:view").allowed, false);
  assert.equal(authorizeRole("owner_admin", "unknown:action").allowed, false);
});
