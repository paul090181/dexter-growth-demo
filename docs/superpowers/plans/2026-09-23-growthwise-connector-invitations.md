# GrowthWise Connector Invitations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure single-use connector invitation and short-lived tenant session that can authorize Dexter's existing Instagram connector without exposing global or tenant credentials.

**Architecture:** PostgreSQL stores only invitation/session token hashes and performs redemption in one transaction. A same-origin customer page receives an invitation through a URL fragment, removes it before network activity, exchanges it for an HttpOnly session cookie, and uses tenant-bound server endpoints. Existing Instagram admin authorization remains intact; Facebook is a safe unavailable slot.

**Tech Stack:** Node.js ES modules, Netlify Functions, Netlify Database/PostgreSQL, static HTML/CSS/JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-23-growthwise-connector-invitations-design.md`

## Global Constraints

- Work only from PR #14 head; deploy only Preview #14.
- Invitation TTL is exactly 24 hours; connector session TTL is exactly 30 minutes; neither slides.
- Store only SHA-256 hashes of 256-bit tokens and never log raw credentials, cookies, OAuth codes, or keys.
- Preserve Dexter as `access_source=pilot`, `status=pilot`; integration authorization is independent of billing.
- Do not change live Meta configuration, add permissions, create Facebook OAuth, create `GROWTHWISE_META_ACCOUNT_MAP`, or touch production.

## Review Focus

- Two simultaneous redemptions must produce exactly one session and one used invitation.
- Cookie parsing with duplicates, malformed values, or attacker-controlled business IDs must fail closed.
- Fragment removal must happen before any fetch or connector navigation.
- A connector session allowing only Facebook must not authorize Instagram health/start.
- OAuth callback routing must preserve current admin destinations while using only the fixed connection-page destination for session starts.

---

### Task 1: Invitation and Session Security Store

**Files:**
- Create: `netlify/database/migrations/20260923180000_connector-invitations/migration.sql`
- Create: `netlify/functions/_connector-auth.mjs`
- Create: `netlify/functions/_connector-store.mjs`
- Create: `tests/integrations/connector-invitation-store.test.mjs`

**Interfaces:**
- Produces: `generateOpaqueToken()`, `hashOpaqueToken()`, and store methods `createInvitation`, `redeemInvitation`, `authorizeSession`, `revokeInvitation`.
- `redeemInvitation` returns safe tenant/session metadata plus the raw session token generated only for that response.

- [ ] Write tests for random token shape/uniqueness, hash-only inserts, 24-hour fixed expiry, expired/revoked/used rejection, one-winner concurrent redemption, 30-minute non-sliding session expiry, exact connector/business binding, and parameterized SQL.
- [ ] Run `node --test tests/integrations/connector-invitation-store.test.mjs`; expect failure because modules and migration do not exist.
- [ ] Implement the minimal migration, crypto helpers, and transactional store.
- [ ] Rerun the focused test; expect all tests to pass.
- [ ] Commit the task.

### Task 2: Invitation HTTP Endpoints and Tenant Resolution

**Files:**
- Create: `netlify/functions/_connector-tenants.mjs`
- Create: `netlify/functions/connector-invitation-create.mjs`
- Create: `netlify/functions/connector-invitation-exchange.mjs`
- Create: `netlify/functions/connector-session.mjs`
- Modify: `netlify/functions/_tenant-store.mjs`
- Create: `tests/integrations/connector-invitation-endpoints.test.mjs`

**Interfaces:**
- Consumes Task 1 store/crypto functions.
- Produces an admin-only creation response `{ invitation_url, expires_at }`, a POST exchange that sets `gw_connector_session`, and safe session metadata.

- [ ] Write tests for admin-only creation, existing pilot/database tenants, connector allowlist, fragment-only URL, no admin/tenant key in URL, one-time response, no-store/referrer headers, cookie flags, invalid token rejection, and safe Facebook unavailable metadata.
- [ ] Run the endpoint tests; expect missing-module failures.
- [ ] Implement exact-shape bounded request handlers and tenant resolution without billing checks.
- [ ] Rerun focused endpoint and Task 1 tests; expect all to pass.
- [ ] Commit the task.

### Task 3: Instagram Session Authorization

**Files:**
- Modify: `netlify/functions/instagram-oauth-start.mjs`
- Modify: `netlify/functions/instagram-connection.mjs`
- Modify: `netlify/functions/_instagram-clients.mjs`
- Modify: `netlify/functions/_instagram-oauth.mjs`
- Modify: `tests/publishing/instagram-oauth.test.mjs`
- Modify: `tests/publishing/instagram-connection.test.mjs`
- Create: `tests/integrations/connector-instagram-auth.test.mjs`

**Interfaces:**
- Consumes Task 1 session authorization.
- Produces dual-path authorization: existing admin key or exact tenant-bound `instagram` connector session.

- [ ] Write tests proving correct-tenant session health/start, cross-tenant and connector-scope rejection, caller business override rejection, fixed customer-page return, and unchanged admin behavior.
- [ ] Run the focused Instagram tests; expect the session path to fail before implementation.
- [ ] Add shared server-side connector authorization and fixed allowlisted return destination without weakening OAuth state, encrypted storage, or callback validation.
- [ ] Rerun all Instagram and connector tests; expect all to pass.
- [ ] Commit the task.

### Task 4: Secure Customer Connection Page

**Files:**
- Create: `connect-accounts.html`
- Create: `assets/connector-invitation.mjs`
- Create: `tests/integrations/connector-invitation-ui.test.mjs`

**Interfaces:**
- Consumes Task 2 exchange/session endpoints and Task 3 Instagram endpoints.
- Produces the reusable customer-facing connection page.

- [ ] Write static/controller tests for immediate fragment removal before fetch, no third-party resources, no credential collection/storage/logging, safe tenant name, Instagram states/actions, Facebook unavailable state, and no-store/referrer controls.
- [ ] Run UI tests; expect missing files/modules.
- [ ] Implement the minimal dependency-free page and controller.
- [ ] Rerun focused UI and connector tests; expect all to pass.
- [ ] Commit the task.

### Task 5: Regression, Review, Preview Acceptance

**Files:**
- Modify only files required by review findings.

**Interfaces:**
- Consumes the complete invitation/session/customer-page flow.
- Produces reviewed PR #14 code and verified Preview #14 acceptance evidence.

- [ ] Run connector, Instagram, billing, publishing, and complete regression suites; inspect all output.
- [ ] Run whitespace and credential-pattern checks.
- [ ] Request one independent whole-branch security review; fix Critical/Important findings test-first in one pass.
- [ ] Rerun focused and full verification, commit, and push the exact reviewed tree to `feat/growthwise-intake-publishing-ux`.
- [ ] Verify GitHub CI and Preview #14 deployment.
- [ ] Create one 24-hour Dexter invitation, redeem it in a fresh browser session, verify Instagram readiness without completing OAuth, verify Facebook unavailable, cross-tenant denial, invitation replay denial, and Dexter `pilot/pilot` state.
- [ ] Confirm no production, live Meta, billing, or configuration resource changed.
