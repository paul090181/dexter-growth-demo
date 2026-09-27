import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createWebsiteFormConfigHandler } from "../../netlify/functions/website-form-config.mjs";
import { createWebsiteFormInfoHandler } from "../../netlify/functions/website-form-info.mjs";
import { createWebsiteFormSubmitHandler } from "../../netlify/functions/website-form-submit.mjs";
import { consumeWebsiteFormId } from "../../assets/website-contact.mjs";

const ORIGIN = "https://deploy-preview-18--euphonious-beijinho-db4b4d.netlify.app";
const BUSINESS_ID = "tierney-town-treats-abcdef123456";
const FORM_ID = "gwf_" + "A".repeat(22);
const NOW = new Date("2026-09-27T20:00:00.000Z");

function configRequest(method = "GET", origin = ORIGIN) {
  return new Request(ORIGIN + "/.netlify/functions/website-form-config", {
    method,
    headers: method === "GET" ? {} : {
      origin,
      "sec-fetch-site": "same-origin",
    },
  });
}

function publicRequest(path, body) {
  return new Request(ORIGIN + "/.netlify/functions/" + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("website form setup is bound to the connector-session tenant and keeps a stable public form id", async () => {
  let row = null;
  const writes = [];
  const handler = createWebsiteFormConfigHandler({
    connectorStore: {},
    connectorAuthorize: async (_request, { connector }) => {
      assert.equal(connector, "website");
      return { ok: true, businessId: BUSINESS_ID, connectors: ["website"] };
    },
    formIdFactory: () => FORM_ID,
    now: () => NOW,
    formStore: {
      async readByBusiness({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return row;
      },
      async ensureEnabled(input) {
        writes.push(input);
        row = row
          ? { ...row, disabled_at: null, updated_at: input.now }
          : {
              business_id: input.businessId,
              form_id: input.formId,
              disabled_at: null,
              created_at: input.now,
              updated_at: input.now,
            };
        return row;
      },
      async disable({ businessId, now }) {
        assert.equal(businessId, BUSINESS_ID);
        if (row) row = { ...row, disabled_at: now, updated_at: now };
        return row;
      },
    },
  });

  const empty = await handler(configRequest());
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).state, "Not Connected");

  const created = await handler(configRequest("POST"));
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.business_id, BUSINESS_ID);
  assert.equal(createdBody.state, "Connected");
  assert.equal(
    createdBody.form_url,
    ORIGIN + "/website-contact.html#form=" + FORM_ID,
  );
  assert.equal(writes.length, 1);
  assert.equal(writes[0].businessId, BUSINESS_ID);

  const existing = await handler(configRequest());
  assert.equal((await existing.json()).form_url, createdBody.form_url);

  const disabled = await handler(configRequest("DELETE"));
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).state, "Not Connected");
  assert.equal((await handler(configRequest())).status, 200);
});

test("website form setup rejects cross-origin mutation and invalid connector sessions before storage", async () => {
  let reads = 0;
  const denied = createWebsiteFormConfigHandler({
    connectorStore: {},
    connectorAuthorize: async () => ({ ok: false, businessId: null }),
    formStore: {
      async readByBusiness() { reads += 1; return null; },
    },
  });
  assert.equal((await denied(configRequest())).status, 401);
  assert.equal(reads, 0);

  const allowed = createWebsiteFormConfigHandler({
    connectorStore: {},
    connectorAuthorize: async () => ({ ok: true, businessId: BUSINESS_ID }),
    formStore: {
      async ensureEnabled() { reads += 1; return null; },
    },
  });
  assert.equal((await allowed(configRequest("POST", "https://evil.example"))).status, 403);
  assert.equal(reads, 0);
});

test("public form info exposes only the business display name for an enabled form", async () => {
  const handler = createWebsiteFormInfoHandler({
    formStore: {
      async readEnabledByFormId({ formId }) {
        assert.equal(formId, FORM_ID);
        return { business_id: BUSINESS_ID, form_id: FORM_ID };
      },
    },
    tenantStore: {
      async readTenantProfile({ businessId }) {
        assert.equal(businessId, BUSINESS_ID);
        return {
          business_id: BUSINESS_ID,
          business_name: "Tierney Town Treats",
          contact_email: "must-not-leak@example.com",
          access_key_hash: "secret-hash",
        };
      },
    },
  });

  const response = await handler(publicRequest("website-form-info", { form_id: FORM_ID }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    business_name: "Tierney Town Treats",
  });
});

test("public website form routes a valid inquiry into the exact tenant inbox without enabling auto reply", async () => {
  const ingested = [];
  const handler = createWebsiteFormSubmitHandler({
    db: {},
    formStore: {
      async readEnabledByFormId({ formId }) {
        assert.equal(formId, FORM_ID);
        return { business_id: BUSINESS_ID, form_id: FORM_ID };
      },
    },
    recentCount: async ({ businessId }) => {
      assert.equal(businessId, BUSINESS_ID);
      return 0;
    },
    ingest: async (input, options) => {
      ingested.push({ input, options });
      return { duplicate: false, lead: { id: "lead-1" } };
    },
  });

  const response = await handler(publicRequest("website-form-submit", {
    form_id: FORM_ID,
    submission_id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Customer",
    email: "customer@example.com",
    phone: "716-555-0100",
    message: "Can I place an order for Saturday?",
    company_website: "",
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, duplicate: false });
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].input.business_id, BUSINESS_ID);
  assert.equal(ingested[0].input.source_type, "website");
  assert.equal(ingested[0].input.customer_contact, "customer@example.com");
  assert.equal(ingested[0].input.reply_supported, false);
  assert.equal(ingested[0].input.source_metadata.phone, "716-555-0100");
  assert.equal(ingested[0].options.ingestionTag, "website_form");
});

test("public website form has honeypot, validation, disabled-form, and per-tenant rate-limit guards", async () => {
  let ingests = 0;
  const base = {
    form_id: FORM_ID,
    submission_id: "550e8400-e29b-41d4-a716-446655440000",
    name: "Customer",
    email: "customer@example.com",
    phone: "",
    message: "Hello",
    company_website: "",
  };

  const honeypot = createWebsiteFormSubmitHandler({
    db: {},
    formStore: { readEnabledByFormId: async () => { throw new Error("should not read"); } },
    recentCount: async () => 0,
    ingest: async () => { ingests += 1; return {}; },
  });
  const bot = await honeypot(publicRequest("website-form-submit", {
    ...base,
    company_website: "spam.example",
  }));
  assert.equal(bot.status, 200);
  assert.equal(ingests, 0);

  const disabled = createWebsiteFormSubmitHandler({
    db: {},
    formStore: { readEnabledByFormId: async () => null },
    recentCount: async () => 0,
    ingest: async () => { ingests += 1; return {}; },
  });
  assert.equal((await disabled(publicRequest("website-form-submit", base))).status, 404);

  const limited = createWebsiteFormSubmitHandler({
    db: {},
    formStore: { readEnabledByFormId: async () => ({ business_id: BUSINESS_ID }) },
    recentCount: async () => 20,
    ingest: async () => { ingests += 1; return {}; },
  });
  assert.equal((await limited(publicRequest("website-form-submit", base))).status, 429);

  const invalid = createWebsiteFormSubmitHandler({
    db: {},
    formStore: { readEnabledByFormId: async () => ({ business_id: BUSINESS_ID }) },
    recentCount: async () => 0,
    ingest: async () => { ingests += 1; return {}; },
  });
  assert.equal((await invalid(publicRequest("website-form-submit", {
    ...base,
    email: "",
    phone: "",
  }))).status, 400);
  assert.equal(ingests, 0);
});

test("website form fragment is removed locally before any network use", () => {
  const changes = [];
  const formId = consumeWebsiteFormId({
    href: ORIGIN + "/website-contact.html#form=" + FORM_ID,
    historyImpl: {
      replaceState(_state, _title, value) { changes.push(value); },
    },
  });
  assert.equal(formId, FORM_ID);
  assert.deepEqual(changes, ["/website-contact.html"]);

  const bad = consumeWebsiteFormId({
    href: ORIGIN + "/website-contact.html#form=bad&next=evil",
    historyImpl: { replaceState() {} },
  });
  assert.equal(bad, "");
});

test("hosted website form is no-store, self-contained, and does not expose tenant credentials", async () => {
  const html = await readFile(new URL("../../website-contact.html", import.meta.url), "utf8");
  const headers = await readFile(new URL("../../_headers", import.meta.url), "utf8");
  const migration = await readFile(new URL(
    "../../netlify/database/migrations/20260927200000_website-lead-forms/migration.sql",
    import.meta.url,
  ), "utf8");

  assert.match(html, /id="contact-form"/);
  assert.match(html, /Powered by Narleo/);
  assert.match(html, /name="company_website"/);
  assert.match(html, /Referrer-Policy/i);
  assert.match(html, /Content-Security-Policy/i);
  assert.doesNotMatch(html, /admin.?key|tenant.?key|localStorage|sessionStorage|console\./i);
  assert.match(headers, /\/website-contact\.html\n\s+Cache-Control: no-store/);
  assert.match(headers, /frame-ancestors 'none'/);
  assert.match(migration, /cardinality\(connectors\) BETWEEN 1 AND 4/);
  assert.match(migration, /'website'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS growthwise_website_forms/);
});
