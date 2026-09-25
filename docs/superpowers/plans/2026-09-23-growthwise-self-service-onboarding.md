# GrowthWise Self-Service Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal, tenant-isolated signup and Stripe activation flow for new $49/month GrowthWise customers on Preview #14.

**Architecture:** A dedicated tenant registry stores minimum contact information and a SHA-256 hash of a 256-bit random tenant key. Signup returns the raw key once; tenant-bound authorization then protects checkout and status while the signed Stripe webhook remains the only subscription writer. The new signup page is separate from Dexter's pilot UI, and tenant keys are never accepted by the existing admin-only endpoints.

**Tech Stack:** Node.js 22 ESM, Netlify Functions, Netlify DB/PostgreSQL, Stripe Checkout/webhooks, Node test runner, static HTML/JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-23-growthwise-self-service-onboarding-design.md`

## Global Constraints

- Stay on PR #14 and deploy only to Deploy Preview #14.
- Do not touch production or rotate credentials.
- Keep the Founding Plan price server-controlled and `plan_key=founding_monthly`.
- Store only a secure hash of each cryptographically random tenant key.
- Email alone never authorizes a request.
- `dexters-hats` remains `access_source=pilot` and `status=pilot`.
- Do not add Customer Portal, recovery, production migration, or unrelated UX work.

## Review Focus

- Concurrent signups with the same normalized business name must still receive distinct IDs and keys.
- Empty, malformed, or oversized signup fields must fail without persistence.
- A valid tenant key paired with another `business_id` must fail before Stripe or storage disclosure.
- A signed Stripe event carrying an unregistered `business_id` must fail closed.
- Tenant keys must remain invalid for an existing admin-only endpoint.

---

### Task 1: Tenant registry and secure authentication

**Files:**
- Create: `netlify/database/migrations/20260923120000_self-service-tenants/migration.sql`
- Create: `netlify/functions/_tenant-auth.mjs`
- Create: `netlify/functions/_tenant-store.mjs`
- Create: `netlify/functions/tenant-signup.mjs`
- Create: `tests/billing/tenant-onboarding.test.mjs`

**Interfaces:**
- Consumes: Netlify DB pool and `json(status, body)`.
- Produces: `createTenantStore()`, `createTenantSignupHandler()`, `generateTenantCredentials()`, and `authorizeTenantRequest()`.

- [ ] **Step 1: Write failing tests** for validated signup, unique IDs, one-time raw key response, hash-only persistence, wrong-key rejection, wrong-business rejection, and oversized input.
- [ ] **Step 2: Run tests to verify RED** with `node --test tests/billing/tenant-onboarding.test.mjs` and confirm failures are missing-module/behavior failures.
- [ ] **Step 3: Implement the minimum registry, key generation/hash, authorization, migration, and signup handler.**
- [ ] **Step 4: Run tests to verify GREEN** with `node --test tests/billing/tenant-onboarding.test.mjs`.
- [ ] **Step 5: Commit** with `git commit -m "feat: add secure tenant onboarding registry"`.

### Task 2: Tenant-bound checkout, status, and webhook eligibility

**Files:**
- Modify: `netlify/functions/stripe-checkout.mjs`
- Modify: `netlify/functions/subscription-status.mjs`
- Modify: `netlify/functions/_stripe-client.mjs`
- Modify: `netlify/functions/_billing-store.mjs`
- Modify: `tests/billing/stripe-checkout.test.mjs`
- Modify: `tests/billing/subscription-status.test.mjs`
- Modify: `tests/billing/billing-store.test.mjs`

**Interfaces:**
- Consumes: `authorizeTenantRequest(request, { businessId, store })` and the tenant registry.
- Produces: tenant-bound checkout/status responses and registered-tenant-only webhook persistence.

- [ ] **Step 1: Write failing tests** for own-tenant checkout/status, cross-tenant rejection, fixed `founding_monthly`, signup return URLs, pre-payment lock, active/trialing grant, and unregistered webhook metadata rejection.
- [ ] **Step 2: Run tests to verify RED** with `node --test tests/billing/stripe-checkout.test.mjs tests/billing/subscription-status.test.mjs tests/billing/billing-store.test.mjs`.
- [ ] **Step 3: Implement the minimum authorization and registry checks without changing admin behavior.**
- [ ] **Step 4: Run tests to verify GREEN** with the same focused command, then `npm run test:billing`.
- [ ] **Step 5: Commit** with `git commit -m "feat: bind billing access to tenant identity"`.

### Task 3: Minimal signup page and isolation regression

**Files:**
- Create: `signup.html`
- Create: `tests/billing/tenant-signup-ui.test.mjs`
- Create: `tests/billing/tenant-isolation.test.mjs`

**Interfaces:**
- Consumes: `tenant-signup`, `stripe-checkout`, and `subscription-status` HTTP contracts.
- Produces: a separate signup/checkout/status UI that does not load Dexter data.

- [ ] **Step 1: Write failing tests** for the three-field form, one-time key handling, tenant-key headers, no client price/plan override, server-confirmed access, return-URL non-activation, and rejection of a tenant key by an admin-only endpoint.
- [ ] **Step 2: Run tests to verify RED** with `node --test tests/billing/tenant-signup-ui.test.mjs tests/billing/tenant-isolation.test.mjs`.
- [ ] **Step 3: Implement the minimal standalone signup page.**
- [ ] **Step 4: Run tests to verify GREEN** with the focused command, then `npm run test:all`.
- [ ] **Step 5: Commit** with `git commit -m "feat: add self-service signup page"`.

### Task 4: Review, preview deployment, and sandbox acceptance

**Files:**
- Modify only if a review finding or verified preview failure requires a test-first fix.

**Interfaces:**
- Consumes: completed Tasks 1-3 and existing PR #14 deployment/webhook configuration.
- Produces: reviewed PR commit and one verified sandbox tenant subscription.

- [ ] **Step 1: Run fresh verification** with `npm run test:billing`, `npm run test:all`, `git diff --check`, and a credential-pattern scan.
- [ ] **Step 2: Obtain one fresh whole-branch code review** against this plan/spec; fix Critical/Important findings via RED-GREEN and rerun suites.
- [ ] **Step 3: Push the reviewed commit** to `origin/feat/growthwise-intake-publishing-ux` without force.
- [ ] **Step 4: Verify Preview #14 is built from the pushed commit** and no production resource changed.
- [ ] **Step 5: Create one test business, confirm it is locked, complete one $49 Stripe sandbox checkout, and verify signed-webhook activation, `access_source=stripe`, cross-tenant denial, and Dexter `pilot/pilot` preservation.**
