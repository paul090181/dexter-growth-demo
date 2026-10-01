import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "netlify", "database", "migrations");

function migrationNames() {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function migrationSql(name) {
  return readFileSync(join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");
}

test("production release migration set is complete and ordered", () => {
  const names = migrationNames();

  assert.equal(names.length, 29, "Production release should contain exactly 29 migrations before first Narleo database cutover.");
  assert.equal(new Set(names).size, names.length, "Migration directory names must be unique.");

  for (const name of names) {
    assert.match(name, /^\d{14}_[a-z0-9-]+$/, `Invalid migration directory name: ${name}`);
    assert.ok(existsSync(join(MIGRATIONS_DIR, name, "migration.sql")), `Missing migration.sql for ${name}`);
    assert.ok(migrationSql(name).trim().length > 0, `Empty migration.sql for ${name}`);
  }
});

test("production migration set avoids table-destructive statements", () => {
  for (const name of migrationNames()) {
    const sql = migrationSql(name);
    assert.doesNotMatch(sql, /\bDROP\s+TABLE\b/i, `${name} must not drop a table during first Production cutover`);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i, `${name} must not truncate Production data`);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i, `${name} must not delete Production data`);
  }
});

test("subscription plan-start migration backfills before enforcing NOT NULL", () => {
  for (const name of [
    "20260925023000_subscription-entitlements",
    "20260925121000_subscription-entitlements",
  ]) {
    const sql = migrationSql(name);
    const backfill = sql.indexOf("UPDATE growthwise_subscriptions");
    const notNull = sql.indexOf("ALTER COLUMN plan_started_at SET NOT NULL");
    assert.ok(backfill >= 0, `${name} must backfill plan_started_at`);
    assert.ok(notNull > backfill, `${name} must backfill before enforcing NOT NULL`);
  }
});

test("critical table dependencies are created before dependent migrations", () => {
  const names = migrationNames();
  const before = (a, b) => assert.ok(names.indexOf(a) < names.indexOf(b), `${a} must run before ${b}`);

  before("20260920194500_retail-customer-leads", "20260920201500_retail-lead-smart-auto");
  before("20260920194500_retail-customer-leads", "20260920215000_unified-lead-inbox");
  before("20260920194500_retail-customer-leads", "20260927204500_lead-won-outcome");
  before("20260921210000_stripe-billing-foundation", "20260925023000_subscription-entitlements");
  before("20260923120000_self-service-tenants", "20260926011000_passwordless-tenant-access");
  before("20260923180000_connector-invitations", "20260924013000_connector-email-constraint");
  before("20260923180000_connector-invitations", "20260927200000_website-lead-forms");
  before("20260927013000_facebook-page-oauth", "20260927014500_facebook-page-selection");
  before("20260927200000_website-lead-forms", "20260927203000_website-form-pilot-support");
});

test("Production callback and webhook functions referenced by the release checklist exist", () => {
  const required = [
    "facebook-oauth-callback.mjs",
    "instagram-oauth-callback.mjs",
    "microsoft-mail-oauth-callback.mjs",
    "microsoft-mail-webhook.mjs",
    "square-oauth-callback.mjs",
    "stripe-webhook.mjs",
    "meta-webhook.mjs",
  ];

  for (const filename of required) {
    assert.ok(
      existsSync(join(process.cwd(), "netlify", "functions", filename)),
      `Missing Production release function: ${filename}`,
    );
  }
});
