# GrowthWise overnight report — 2026-09-17

## Executive summary

GrowthWise now copies successful Dexter Square product creation into four independent Publishing Core shadow drafts without replacing or blocking the existing Square/Facebook workflow. Instagram gained reusable tenant-aware connection health and safe post preview/readiness foundations. A paying retailer can prepare multiple channel drafts from one product entry, see whether Instagram needs attention, and avoid repeating draft work while all new actions remain non-live.

## Commercial value

* One normalized Dexter product can prepare Facebook Page, Facebook Marketplace, Instagram, and Website outputs.
* The bridge is automatic after Square success and best-effort, reducing duplicate entry without weakening the trusted fallback.
* Instagram readiness distinguishes connection problems and media-hosting blockers before a user wastes time attempting publication.
* Value metrics count products, attempts, prepared drafts, failures, estimated manual draft actions avoided, and preparation duration. No revenue is fabricated.

## Instagram

Implemented: shared configuration by `business_id`, server-only credential references, read-only professional-account discovery, redacted Not Connected / Connected / Needs Attention responses, caption/media preview, and shadow readiness blockers. `growth.wise1` is configured as a strategy—not a hard-coded ID—and must be discovered from Meta.

Paul's exact steps and Dexter's same-flow onboarding are in `docs/INSTAGRAM_CONNECTION_RUNBOOK.md`. Paul must confirm professional status and Page linkage, prepare the Meta app, approve/implement secure OAuth, place any temporary development token only in server configuration, and run the redacted health check. Dexter later authorizes the same flow for his tenant without a code change. OAuth interaction, durable credential persistence, public media hosting, and every live publish remain blocked.

## Dexter bridge

After either “Save to Square only” or “Add to Square & Promote” successfully creates a product, the page submits a non-awaited copy to Publishing Core for Facebook Page, Marketplace, Instagram, and Website. Marketplace remains manual/assisted. Core errors are caught and only warned; they cannot enter the existing Square/Facebook error path. All Core results remain shadow-only with `live_sent: false`. Existing Square and Facebook functions were not modified.

## Issues found

* **High (launch blocker for Instagram live):** browser/base64 images are not durable Meta-retrievable URLs.
* **High (launch blocker for customer connection):** no approved server OAuth callback/encrypted credential store exists; the admin key is suitable only for the current pilot boundary.
* **Medium:** Publishing Core previously treated Instagram as registry-only and offered no media-readiness signal.
* **Medium:** successful Dexter product creation did not feed the reusable Core, causing repeated channel preparation.
* **Low / environment:** the repository dependency was not installed; registry access returned HTTP 403, preventing two Blob-importing tests from loading.

## Fixes made

* `fb4e8dc` — persisted the approved design and TDD implementation plan.
* `4d877fa` — added tenant-safe Instagram health/discovery and redacted states.
* `68381b5` — added Instagram shadow preview and safe media classification.
* `e2eacc8` — added the non-blocking four-channel Dexter bridge.
* `2f4415a` — added conservative preparation-value metrics.

## Testing

* `node --test tests/publishing/instagram-connection.test.mjs`: **4 passed, 0 failed**.
* `node --test tests/publishing/channel-drafts.test.mjs`: **5 passed, 0 failed**.
* `node --test tests/publishing/dexter-shadow-bridge.test.mjs`: **2 passed, 0 failed**.
* `node --test tests/publishing/shadow-value.test.mjs`: **2 passed, 0 failed**.
* Combined new/relevant focused suite: **13 passed, 0 failed**.
* `npm run test:publishing`: **49 passed, 2 failed to load** because `@netlify/blobs` was unavailable locally.
* Runnable publishing suite excluding only the two Blob-importing files: **49 passed, 0 failed**.
* `npm install --no-audit --no-fund`: **not runnable successfully in this environment**; npm registry returned HTTP 403 for `@netlify/blobs`.

Fresh final command results are recorded before handoff; no unexecuted check is described as passing.

## Security review

Tenant configuration is allowlisted and checked against the requested `business_id`. Tokens are resolved only from server environment references, sent in an authorization header, and never returned or intentionally logged. Raw Graph failures and external account IDs are withheld. Connection checks are read-only. Existing role/permission and master-package tenant checks remain. Shadow output remains non-live and channel attempts remain independent. The browser still uses the pre-existing beta admin key boundary; production OAuth/session architecture is explicitly deferred.

## Business-value metrics

Each persisted shadow run and response now records products processed, channels attempted, successful/failed preparations, channel drafts prepared, a conservative “one manual draft action per successful channel” estimate, and elapsed preparation milliseconds. Future sales attribution requires commerce/campaign linkage and must not be inferred from these metrics.

## Blockers

* **Paul / Meta:** professional-account/Page linkage, app configuration, permissions/tester or review status, and interactive authorization.
* **Architecture:** server OAuth state/callback and encrypted tenant credential lifecycle.
* **Architecture:** durable tenant-isolated media hosting and delivery policy.
* **Environment:** npm registry policy prevented installation of `@netlify/blobs`.
* **Approval:** any live Instagram test or new live Publishing Core action.

## DECISION NEEDED

1. Select OAuth credential storage, encryption/key management, refresh/revocation, session membership enforcement, and redirect deployment architecture.
2. Select durable media storage, public/signed URL behavior compatible with Meta retrieval, retention/deletion, and tenant access policy.
3. Approve a separately scoped live-test account, content, confirmation UI, rollback/removal plan, and audit evidence only after 1–2 are complete.

## Recommended morning actions

1. Review this report and the Instagram runbook; confirm no live action is expected.
2. Confirm `growth.wise1` professional status and Facebook Page linkage.
3. Review Meta app products, redirect URI, least-privilege permissions, tester/app-review requirements, and token duration.
4. Decide the OAuth credential and media-hosting architectures.
5. Install dependencies in an allowed environment and rerun `npm run test:publishing`.
6. Exercise Dexter's Square Sandbox product creation and verify a persisted four-channel shadow run without publishing new Facebook/Instagram content.

## Highest-value next moves

1. **Secure self-serve Meta OAuth:** removes the largest onboarding obstacle while preserving multi-tenant trust.
2. **Small durable media handoff:** unlocks API-valid Instagram readiness and reuse across Website/Page drafts without a broad media platform.
3. **Pilot value dashboard:** show Dexter products processed, healthy connections, drafts prepared, failures recovered, and estimated time saved so subscription value is visible.
