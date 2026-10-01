# GrowthWise Publishing Core v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shadow-mode, multi-client Publishing Core that converts Automotive and Retail records into one protected master package, generates channel-specific drafts for all eleven registered channels, enforces client automation and role rules, creates isolated duplicate-safe jobs, and exposes a secure shadow service without changing the working Auto City or Dexter publishing flows.

**Architecture:** Use small ES modules under `core/publishing/` for normalized data, policies, channels, jobs, orchestration, and audit behavior; use `verticals/` adapters to translate Automotive and Retail records; use `integrations/channels/` adapters that only consume normalized packages/drafts; and use a Netlify shadow endpoint plus Netlify Blobs for secure pilot persistence. Existing `automotive-pilot.html`, `index.html`, and `netlify/functions/facebook-post.mjs` remain untouched during this plan.

**Tech Stack:** Node.js ES modules (`.mjs`), built-in `node:test` and `node:assert/strict`, built-in `node:crypto`, Netlify Functions, existing `@netlify/blobs`, JSON client configuration.

**Spec:** `docs/superpowers/specs/2026-09-16-growthwise-publishing-core-design.md`

## Global Constraints

- Work only on `platform-v1`; do not merge to `main` as part of this plan.
- Do not move, rename, delete, or wire the current live Automotive or Dexter entry points.
- Do not modify `automotive-pilot.html`, `index.html`, or the current `netlify/functions/facebook-post.mjs` publishing path in v1 shadow work.
- Every package, draft, job, audit record, and persisted key must carry or be namespaced by `business_id`.
- Facebook Marketplace is a separate first-class channel and begins in Assisted/Shadow mode.
- All eleven channels must exist in the registry from v1, even when their implementation status is registry-only or export-only.
- No live external publishing from the new Publishing Core during this plan.
- AI-generated/channel copy may vary wording but must not silently change verified facts.
- Client automation levels are exactly `manual`, `review`, and `automatic`.
- Delivery modes are exactly `direct`, `assisted`, and `export`.
- Initial roles are `owner_admin`, `manager`, `staff`, and `view_only`.
- Use no new runtime dependency for the core; use the repository's existing `@netlify/blobs` only for persistence.
- Each task follows TDD: failing test, verify failure, minimal implementation, verify pass, then commit.

---

## File Map

The plan creates these focused units:

- `core/publishing/constants.mjs` — shared enums/constants.
- `core/publishing/channels/registry.mjs` — eleven channel capability records and lookup functions.
- `core/publishing/master-package/create.mjs` — normalized master-package construction.
- `core/publishing/master-package/validate.mjs` — package/media/business-scope validation.
- `core/publishing/master-package/facts.mjs` — protected-fact comparison/override checks.
- `core/publishing/automation/policy.mjs` — business/channel/action automation resolution.
- `core/publishing/automation/permissions.mjs` — role/action authorization.
- `core/publishing/channels/draft.mjs` — independent channel-draft generation and capability filtering.
- `core/publishing/orchestration/jobs.mjs` — job creation, statuses, transitions, retry classification, idempotency.
- `core/publishing/audit/events.mjs` — normalized business-scoped audit events.
- `core/publishing/orchestration/shadow.mjs` — shadow-only end-to-end orchestration.
- `verticals/automotive/publishing-adapter/index.mjs` — vehicle-to-master input mapping.
- `verticals/retail/publishing-adapter/index.mjs` — product-to-master input mapping.
- `verticals/property/publishing-adapter/contract.mjs` and `verticals/services/publishing-adapter/contract.mjs` — contract-only examples proving future verticals need not alter Core.
- `integrations/channels/*/adapter.mjs` — eleven adapters with a common preparation-only contract in v1.
- `netlify/functions/_publishing-store.mjs` — business-namespaced shadow job/audit persistence.
- `netlify/functions/publishing-shadow.mjs` — admin-key-protected shadow endpoint; never calls external publishing APIs.
- `tests/publishing/*.test.mjs` and fixtures — layered tests.
- `clients/auto-city.json`, `clients/dexters-hats.json` — publishing defaults/overrides, still preserving current module settings.
- `package.json` — test script only.

---

### Task 1: Test Harness, Constants, and Eleven-Channel Registry

**Files:**
- Modify: `package.json`
- Create: `core/publishing/constants.mjs`
- Create: `core/publishing/channels/registry.mjs`
- Create: `tests/publishing/channel-registry.test.mjs`

**Interfaces:**
- Produces: `DELIVERY_MODES`, `AUTOMATION_LEVELS`, `ROLES`, `JOB_STATUSES`
- Produces: `CHANNELS`, `getChannel(channelId)`, `listChannels()`
- Later tasks consume the exact channel IDs defined here.

- [ ] **Step 1: Add the failing registry test**

Create `tests/publishing/channel-registry.test.mjs` with assertions that there are exactly eleven unique channels and that `facebook-page` and `facebook-marketplace` are separate entries. Assert every entry has `id`, `displayName`, `deliveryMode`, `implementationStatus`, `capabilities`, and `automaticActionsAllowed`.

```js
import test from "node:test";
import assert from "node:assert/strict";
import { listChannels, getChannel } from "../../core/publishing/channels/registry.mjs";

test("registry exposes all eleven first-class channels", () => {
  const channels = listChannels();
  assert.equal(channels.length, 11);
  assert.equal(new Set(channels.map((c) => c.id)).size, 11);
  assert.equal(getChannel("facebook-page").deliveryMode, "direct");
  assert.equal(getChannel("facebook-marketplace").deliveryMode, "assisted");
  assert.notDeepEqual(getChannel("facebook-page"), getChannel("facebook-marketplace"));
  for (const channel of channels) {
    assert.ok(channel.displayName);
    assert.ok(["direct", "assisted", "export"].includes(channel.deliveryMode));
    assert.ok(channel.capabilities && typeof channel.capabilities === "object");
    assert.equal(typeof channel.automaticActionsAllowed, "boolean");
  }
});
```

- [ ] **Step 2: Add the test script and verify RED**

Add to `package.json` without changing the existing dependency:

```json
"scripts": {
  "test:publishing": "node --test tests/publishing/*.test.mjs"
}
```

Run: `npm run test:publishing`

Expected: FAIL because `core/publishing/channels/registry.mjs` does not exist.

- [ ] **Step 3: Implement constants and registry**

Use these exact channel IDs:

```js
facebook-page
facebook-marketplace
instagram
website
ebay
etsy
pinterest
craigslist
mercari
tiktok
google-business-profile
```

Set the initial safest delivery modes:

- `facebook-page`: `direct`, implementation status `existing-live-path-not-wired-to-core`
- `facebook-marketplace`: `assisted`, implementation status `shadow`
- all remaining channels: `export` unless a later dedicated integration task proves a stronger mode; implementation status `registry-only`

Registry records must include capability keys for `photos`, `video`, `price`, `inventory`, `location`, `categories`, `links`, `update`, `remove`, and `statusReadback`. Unknown/unverified capabilities are represented as `false` or a documented numeric/null limit, never guessed by adapters.

- [ ] **Step 4: Verify GREEN**

Run: `npm run test:publishing`

Expected: all registry tests PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json core/publishing/constants.mjs core/publishing/channels/registry.mjs tests/publishing/channel-registry.test.mjs
git commit -m "feat: add publishing channel registry"
```

---

### Task 2: Master Package, Media Validation, and Protected Facts

**Files:**
- Create: `core/publishing/master-package/create.mjs`
- Create: `core/publishing/master-package/validate.mjs`
- Create: `core/publishing/master-package/facts.mjs`
- Create: `tests/publishing/master-package.test.mjs`

**Interfaces:**
- Produces: `createMasterPackage(input)` -> normalized package object.
- Produces: `validateMasterPackage(pkg)` -> `{ ok, errors }`.
- Produces: `compareProtectedFacts(master, candidate, approvedOverrides=[])` -> `{ ok, changes, errors }`.
- Required master fields: `business_id`, `source`, `item_type`, `title`, `description`, `media`, `verified_facts`, `attributes`, `source_of_truth`, `approval`, `created_at`, `updated_at`.

- [ ] **Step 1: Write failing tests for business scope and protected facts**

Tests must prove:

1. missing `business_id` is invalid;
2. ordered media is preserved;
3. `source_of_truth.mode` accepts only `growthwise`, `external`, `bidirectional`;
4. changing `verified_facts.price` or `verified_facts.vin` without an approved override fails;
5. changing marketing description alone succeeds;
6. an explicit override such as `approvedOverrides: ["price"]` records the change instead of silently accepting it.

Example assertion:

```js
const check = compareProtectedFacts(master, {
  ...master,
  verified_facts: { ...master.verified_facts, price: 12995 }
});
assert.equal(check.ok, false);
assert.match(check.errors[0], /price/i);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/publishing/master-package.test.mjs`

Expected: FAIL because master-package modules do not exist.

- [ ] **Step 3: Implement normalization and validation**

`createMasterPackage()` must copy input into a new object, normalize strings, keep `attributes` flexible, preserve media ordering, and never infer a missing business ID. Media entries use this shape:

```js
{
  id: "photo-1",
  type: "image",
  url: "https://..." ,
  role: "hero",
  order: 0,
  approved: true
}
```

The validator returns human-readable errors such as `"business_id is required"` and `"media[0].type must be image or video"`.

`compareProtectedFacts()` compares keys present in the master's `verified_facts`; a change is allowed only when the exact key appears in `approvedOverrides`.

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/publishing/master-package.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/publishing/master-package tests/publishing/master-package.test.mjs
git commit -m "feat: add protected publishing master package"
```

---

### Task 3: Automotive and Retail Vertical Adapters

**Files:**
- Create: `verticals/automotive/publishing-adapter/index.mjs`
- Create: `verticals/retail/publishing-adapter/index.mjs`
- Create: `verticals/property/publishing-adapter/contract.mjs`
- Create: `verticals/services/publishing-adapter/contract.mjs`
- Create: `tests/publishing/fixtures/automotive-vehicle.mjs`
- Create: `tests/publishing/fixtures/retail-product.mjs`
- Create: `tests/publishing/vertical-adapters.test.mjs`

**Interfaces:**
- Produces: `automotiveToMasterInput({ businessId, vehicle, media, business })`.
- Produces: `retailToMasterInput({ businessId, product, media, business })`.
- Both outputs are passed to `createMasterPackage()`; neither adapter knows about a destination channel.

- [ ] **Step 1: Write failing fixture tests**

The Automotive fixture must contain `stock`, `vin`, `year`, `make`, `model`, `trim`, `mileage`, `asking`, `status`, and at least two ordered photos. The Retail fixture must contain `sku`, `brand`, `name`, `price`, `quantity`, `color`, `size`, `variant`, and at least one photo.

Assert Automotive protected facts include VIN, stock, mileage, price, and availability. Assert Retail protected facts include SKU, quantity, price, and availability. Assert vertical-only details appear under `attributes`, not as new Core-required fields.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/publishing/vertical-adapters.test.mjs`

Expected: FAIL because the adapters do not exist.

- [ ] **Step 3: Implement both adapters**

Automotive title format for the fixture: `[year, make, model, trim].filter(Boolean).join(" ")`.

Retail title uses `product.name` and optionally brand only when it is not already present in the name.

The contract files for Property and Services export only a frozen descriptor documenting that a future adapter must produce the same master-input shape. They contain no fake property-management or service-business functionality.

- [ ] **Step 4: Validate each adapter through the Core validator**

Tests must call `createMasterPackage(adapterOutput)` and `validateMasterPackage()` and expect `{ ok: true }` for both pilot fixtures.

Run: `node --test tests/publishing/vertical-adapters.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add verticals tests/publishing/fixtures tests/publishing/vertical-adapters.test.mjs
git commit -m "feat: add automotive and retail publishing adapters"
```

---

### Task 4: Client Automation Policies and Role Permissions

**Files:**
- Create: `core/publishing/automation/policy.mjs`
- Create: `core/publishing/automation/permissions.mjs`
- Modify: `clients/auto-city.json`
- Modify: `clients/dexters-hats.json`
- Create: `tests/publishing/policy-permissions.test.mjs`

**Interfaces:**
- Produces: `resolveAutomationLevel(config, channelId, action)` -> `manual | review | automatic`.
- Produces: `authorizeRole(role, action)` -> `{ allowed, reason }`.
- Precedence: action override > channel override > business default.

- [ ] **Step 1: Write failing precedence and permission tests**

Tests must prove:

- Auto City Marketplace resolves to `manual` in v1.
- Dexter Marketplace resolves to `manual` in v1.
- a channel override beats the business default;
- an action override beats the channel override;
- `owner_admin` can approve/publish/configure;
- `manager` can approve/publish but cannot change integration secrets;
- `staff` can create/edit drafts but cannot approve automatic publishing;
- `view_only` cannot mutate drafts or publish.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/publishing/policy-permissions.test.mjs`

Expected: FAIL because policy/permission modules do not exist.

- [ ] **Step 3: Add publishing policy blocks to both client configs**

Preserve the existing fields and add:

```json
"publishing": {
  "shadow_mode": true,
  "live_actions_enabled": false,
  "automation": {
    "default": "review",
    "channels": {
      "facebook-marketplace": "manual"
    },
    "actions": {}
  }
}
```

The v1 config must keep `live_actions_enabled` false for both clients.

- [ ] **Step 4: Implement policy resolution and permissions**

Permission actions are explicit strings: `draft:create`, `draft:edit`, `draft:approve`, `publish:request`, `publish:auto`, `settings:automation`, `settings:integrations`, `analytics:view`.

Unknown roles/actions deny by default.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/publishing/policy-permissions.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/publishing/automation clients tests/publishing/policy-permissions.test.mjs
git commit -m "feat: add client publishing policies and roles"
```

---

### Task 5: Channel Drafts and Adapter Contract for All Eleven Channels

**Files:**
- Create: `core/publishing/channels/draft.mjs`
- Create: `integrations/channels/_contract.mjs`
- Create one `adapter.mjs` under each of the eleven channel directories.
- Create: `tests/publishing/channel-drafts.test.mjs`

**Interfaces:**
- Produces: `createChannelDraft(masterPackage, channelId, options={})`.
- Every channel adapter exports `{ channelId, prepare({ masterPackage, draft, context }) }`.
- `prepare()` returns `{ channel_id, delivery_mode, implementation_status, payload, instructions }` and performs no network call in v1.

- [ ] **Step 1: Write failing tests for eleven drafts**

For both the vehicle and retail fixture master packages, loop through `listChannels()` and create a draft. Assert:

- draft `business_id` exactly matches the master package;
- draft has its own `channel_id` and `draft_id`;
- modifying draft description does not mutate the master package;
- unsupported media/features are omitted or reported in `warnings` rather than invented;
- Marketplace returns Assisted mode and a distinct Marketplace payload/instructions;
- Facebook Page returns Direct mode metadata but remains `shadow_only: true` in this implementation.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/publishing/channel-drafts.test.mjs`

Expected: FAIL because draft and channel adapter modules do not exist.

- [ ] **Step 3: Implement the generic draft builder**

A draft contains:

```js
{
  draft_id,
  business_id,
  master_id,
  channel_id,
  title,
  description,
  price,
  media,
  category: null,
  calls_to_action: [],
  warnings: [],
  protected_fact_overrides: [],
  created_at,
  updated_at
}
```

Before returning a draft, apply registry media/count support. Do not alter verified facts.

- [ ] **Step 4: Implement all eleven preparation-only adapters**

The Facebook Marketplace adapter must explicitly return Assisted instructions and never import/call Meta/Facebook network code. The Facebook Page adapter may map a payload compatible with the existing Page function (`message`, `image_data_urls`) for comparison, but it must not call `facebook-post.mjs` in this plan. Registry-only channels create export-safe payloads from normalized fields.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/publishing/channel-drafts.test.mjs`

Expected: PASS for all eleven channels and both vertical fixtures.

- [ ] **Step 6: Commit**

```bash
git add core/publishing/channels integrations/channels tests/publishing/channel-drafts.test.mjs
git commit -m "feat: add channel drafts and shadow adapters"
```

---

### Task 6: Independent Jobs, Failure Classification, Retries, and Duplicate Protection

**Files:**
- Create: `core/publishing/orchestration/jobs.mjs`
- Create: `tests/publishing/jobs.test.mjs`

**Interfaces:**
- Produces: `createPublishingJob({ businessId, masterId, draftId, channelId, action, revision })`.
- Produces: `idempotencyKey(input)` using SHA-256.
- Produces: `transitionJob(job, nextStatus, patch={})`.
- Produces: `classifyFailure(error)` -> `{ type, retryable, userMessage }`.
- Produces: `retryDecision(job, failure, maxAttempts=3)`.

- [ ] **Step 1: Write failing job tests**

Tests must prove:

- identical business/master/channel/action/revision inputs produce the same idempotency key;
- a different revision or intentional republish action produces a different key;
- jobs from different businesses never share the same key;
- temporary timeout/rate-limit failures can schedule retry before attempt 3;
- missing category/permission/approval failures are business-rule failures and do not retry;
- after the bounded retry count, the next status is `Needs Attention`;
- one failed channel job does not mutate a sibling channel job.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/publishing/jobs.test.mjs`

Expected: FAIL because `jobs.mjs` does not exist.

- [ ] **Step 3: Implement status transitions and SHA-256 keying**

Use `node:crypto` and include `businessId` in the canonical string before hashing. Reject cross-business patches: `transitionJob()` must throw if a patch attempts to change `business_id`.

Use human-readable messages, for example:

```js
{
  type: "business_rule",
  retryable: false,
  userMessage: "Marketplace needs a category before this listing can be prepared."
}
```

- [ ] **Step 4: Verify GREEN**

Run: `node --test tests/publishing/jobs.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add core/publishing/orchestration/jobs.mjs tests/publishing/jobs.test.mjs
git commit -m "feat: add isolated publishing jobs and retries"
```

---

### Task 7: Audit Events and Shadow Orchestrator

**Files:**
- Create: `core/publishing/audit/events.mjs`
- Create: `core/publishing/orchestration/shadow.mjs`
- Create: `tests/publishing/shadow-orchestrator.test.mjs`

**Interfaces:**
- Produces: `createAuditEvent({ businessId, actor, action, entityType, entityId, details })`.
- Produces: `runShadowPublishing({ businessId, role, masterPackage, clientConfig, channelIds, action="publish:create" })`.
- Returns `{ mode: "shadow", business_id, master_id, results, audit_events }`.

- [ ] **Step 1: Write failing end-to-end shadow tests**

Use the two fixture masters. Assert:

- all output objects carry the originating `business_id`;
- passing a master package for `auto-city` with `businessId: "dexters-hats"` throws a tenant mismatch before draft/job creation;
- `view_only` cannot request publication;
- Marketplace is prepared as Assisted and never marked Published;
- a channel error returns a result for that channel while sibling results remain intact;
- `mode` is always `shadow`;
- no result has `live_sent: true`;
- each attempted channel creates an audit event.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/publishing/shadow-orchestrator.test.mjs`

Expected: FAIL because audit/orchestrator modules do not exist.

- [ ] **Step 3: Implement audit normalization and shadow orchestration**

The orchestrator sequence is exactly:

1. assert `businessId === masterPackage.business_id`;
2. validate master package;
3. authorize requested action;
4. resolve client automation level per channel/action;
5. create independent channel draft;
6. create job/idempotency key;
7. call only the channel adapter's `prepare()` method;
8. set shadow result status (`Draft` for manual, `Waiting Approval` for review, `Queued` only as a simulated status for automatic); never `Published`;
9. append audit event;
10. return all channel results even if one fails.

- [ ] **Step 4: Verify GREEN and full regression suite**

Run: `npm run test:publishing`

Expected: all publishing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add core/publishing/audit core/publishing/orchestration/shadow.mjs tests/publishing/shadow-orchestrator.test.mjs
git commit -m "feat: add publishing shadow orchestrator"
```

---

### Task 8: Secure Netlify Shadow Service and Business-Scoped Persistence

**Files:**
- Create: `netlify/functions/_publishing-store.mjs`
- Create: `netlify/functions/publishing-shadow.mjs`
- Create: `tests/publishing/publishing-store.test.mjs`
- Create: `tests/publishing/publishing-shadow-endpoint.test.mjs`

**Interfaces:**
- `_publishing-store.mjs` exports `publishingStore()`, `jobKey(job)`, `auditKey(event)`, `saveShadowRun(run)`, and tenant-safe read helpers used only by tests/admin diagnostics.
- `publishing-shadow.mjs` accepts `POST` only and requires the existing `GROWTHWISE_ADMIN_KEY` through `X-GrowthWise-Key`.
- Request body shape: `{ business_id, role, vertical, source_record, media, channels }`.

- [ ] **Step 1: Write failing store tests using an injected fake store**

Do not require a live Netlify account for unit tests. `_publishing-store.mjs` must accept an optional store dependency in save helpers. Assert stored keys begin with `business/<business_id>/` and reject a requested business ID that does not match the record.

- [ ] **Step 2: Write failing endpoint tests around an exported handler function**

Structure the function so the request handler can be imported and tested without deploying. Tests must assert 401 for bad key, 405 for non-POST, 400 for unknown business/vertical, and 200 for valid Automotive/Retail shadow requests. The response must contain `mode: "shadow"` and `live_actions_enabled: false`.

- [ ] **Step 3: Verify RED**

Run: `node --test tests/publishing/publishing-store.test.mjs tests/publishing/publishing-shadow-endpoint.test.mjs`

Expected: FAIL because the Netlify shadow files do not exist.

- [ ] **Step 4: Implement Netlify Blob persistence following existing repository patterns**

Use `getStore({ name: "growthwise-publishing-v1", consistency: "strong" })`. Namespace every key:

```text
business/<business_id>/job/<idempotency_key>
business/<business_id>/audit/<timestamp>-<event_id>
```

`saveShadowRun()` writes only shadow outputs and audit records. It must not call an external channel API.

- [ ] **Step 5: Implement the protected endpoint**

Follow the repository's existing `GROWTHWISE_ADMIN_KEY` header pattern. Support only `auto-city`/Automotive and `dexters-hats`/Retail in this v1 endpoint, loaded through an explicit business-to-client-config mapping so a caller cannot inject arbitrary client configuration. Reject any request when the client's `publishing.shadow_mode` is not true or `live_actions_enabled` is not false.

- [ ] **Step 6: Verify GREEN and full suite**

Run: `npm run test:publishing`

Expected: all tests PASS, with no network calls to Facebook or any other destination.

- [ ] **Step 7: Commit**

```bash
git add netlify/functions/_publishing-store.mjs netlify/functions/publishing-shadow.mjs tests/publishing/publishing-store.test.mjs tests/publishing/publishing-shadow-endpoint.test.mjs
git commit -m "feat: add secure publishing shadow service"
```

---

### Task 9: Shadow Comparison Fixtures and v1 Acceptance Gate

**Files:**
- Create: `tests/publishing/shadow-comparison.test.mjs`
- Create: `docs/PUBLISHING_CORE_V1_SHADOW_RUNBOOK.md`
- Modify: `platform-manifest.json`

**Interfaces:**
- Acceptance tests consume existing fixture masters and the new shadow orchestrator.
- The runbook defines how to test without enabling live publishing.

- [ ] **Step 1: Write the failing acceptance test**

The acceptance test must assert all v1 success criteria that are machine-verifiable:

- both pilot verticals create valid packages;
- registry has eleven channels;
- Marketplace is separate and Assisted;
- every channel has one of the three delivery modes;
- fact mutation is blocked;
- automation precedence works;
- role checks work;
- cross-business orchestration is rejected;
- one channel failure does not cancel siblings;
- retries are bounded and duplicate-safe;
- shadow runs never report a live send.

- [ ] **Step 2: Run the acceptance test before final documentation**

Run: `node --test tests/publishing/shadow-comparison.test.mjs`

Expected: FAIL until any uncovered acceptance gaps are fixed in the smallest owning module. Do not weaken the test to force a pass.

- [ ] **Step 3: Fix only acceptance gaps and rerun the full suite**

Run: `npm run test:publishing`

Expected: PASS with zero failed tests.

- [ ] **Step 4: Write the shadow runbook**

`docs/PUBLISHING_CORE_V1_SHADOW_RUNBOOK.md` must document:

- endpoint path `/.netlify/functions/publishing-shadow`;
- required `X-GrowthWise-Key` admin header;
- supported pilot businesses/verticals;
- example Automotive and Retail request shapes using fake fixture data, not secrets;
- interpretation of Manual / Review / Automatic shadow statuses;
- where `Needs Attention` comes from;
- explicit statement that Publishing Core v1 does not publish externally;
- comparison checklist against existing Auto City/Dexter output;
- rollback: disable/remove calls to the new shadow endpoint; legacy flows are unchanged.

- [ ] **Step 5: Update the platform manifest without claiming production migration**

Add a `publishing_core` block while keeping `production_paths_moved: false`:

```json
"publishing_core": {
  "version": "1.0-shadow",
  "status": "shadow",
  "live_actions_enabled": false,
  "channels_registered": 11
}
```

- [ ] **Step 6: Run final verification before the acceptance commit**

Run these commands fresh:

```bash
npm run test:publishing
git diff --check
git status --short
```

Expected: publishing suite exits 0; `git diff --check` prints no errors; status contains only the intended Task 9 files.

Also manually verify:

```bash
git diff -- automotive-pilot.html index.html netlify/functions/facebook-post.mjs
```

Expected: no output, proving this plan did not modify the working entry points or existing Facebook Page publishing function.

- [ ] **Step 7: Commit**

```bash
git add tests/publishing/shadow-comparison.test.mjs docs/PUBLISHING_CORE_V1_SHADOW_RUNBOOK.md platform-manifest.json
git commit -m "test: verify publishing core shadow v1"
```

---

## Post-Plan Review Gate

After Task 9, stop before any live channel migration. Review the test output and a real shadow comparison from Auto City and Dexter. A separate bounded/architectural decision is required before wiring any existing UI button or `facebook-post.mjs` call into Publishing Core, and Facebook Marketplace remains Assisted unless a supported direct integration is independently verified.

## Spec Coverage Self-Review

- Tenant isolation: Tasks 2, 4, 6, 7, 8, 9.
- GrowthWise master/source-of-truth metadata: Task 2.
- Protected facts/AI safety contract: Tasks 2 and 9.
- Automotive/Retail vertical adapters plus future vertical contract: Task 3.
- Eleven channels including separate Facebook Marketplace: Tasks 1, 5, 9.
- Manual/Review/Automatic and role permissions: Task 4.
- Independent drafts: Task 5.
- Jobs, retry classification, duplicate protection, `Needs Attention`: Task 6.
- Audit events and channel isolation: Task 7.
- Hybrid secure server layer and tenant-namespaced persistence: Task 8.
- Shadow mode, no live publishing, gradual rollout gate: Tasks 7–9.
- Existing Auto City/Dexter flows preserved: Global Constraints and Task 9 final diff verification.

No live adapter cutover, full CRM, Property product, Services product, SaaS billing, or permanent client fork is included in this plan.