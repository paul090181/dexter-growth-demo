# GrowthWise Instagram + Dexter Profit Sprint Implementation Plan

> Execute in small red/green/refactor increments. Inspect each target first, run the focused test, review the diff, run `npm run test:publishing`, and commit each task separately.

**Goal:** Add a non-blocking Dexter shadow bridge and reusable, tenant-safe Instagram connection/preparation foundation without changing existing live behavior.

**Architecture:** Extend Publishing Core adapters and its secure Netlify boundary. Keep Meta credentials behind server-only environment references. Integrate Dexter by a best-effort post-success call from the existing browser workflow only if narrowly safe; otherwise deliver a tested bridge interface without disturbing the fallback.

## Task 1: Persist approved architecture

**Files:**
* Add `docs/superpowers/specs/2026-09-17-growthwise-instagram-dexter-profit-sprint-design.md`
* Add `docs/superpowers/plans/2026-09-17-growthwise-instagram-dexter-profit-sprint.md`

**Checks:** `git diff --check` and self-review for unclear authorization, media, tenant, fallback, and live-action boundaries.
**Commit:** `docs: define Instagram Dexter profit sprint`

## Task 2: Build Instagram connection health boundary (TDD)

**Files:**
* Add `netlify/functions/instagram-connection.mjs`
* Add `tests/publishing/instagram-connection.test.mjs`
* Modify `clients/dexters-hats.json`

**Interface:** `GET /.netlify/functions/instagram-connection?business_id=...`, authenticated with `X-GrowthWise-Key`; injected fetch/env dependencies for deterministic tests. It returns only `state`, safe discovered identity, `checked_at`, and remediation.

**Red:** Test Not Connected, Connected discovery, Needs Attention, wrong tenant/key, unsupported mutations, and absence of token/raw Meta response.
**Green:** Implement tenant allowlist/config lookup and read-only `/me/accounts` plus linked `instagram_business_account` discovery.
**Commands:** `node --test tests/publishing/instagram-connection.test.mjs`; `npm run test:publishing`.
**Commit:** `feat: add tenant-safe Instagram connection health`

## Task 3: Prepare Instagram preview and safe media readiness (TDD)

**Files:**
* Modify `integrations/channels/instagram/adapter.mjs`
* Modify `core/publishing/channels/registry.mjs`
* Add/modify `tests/publishing/channel-drafts.test.mjs`

**Interface:** `prepare()` returns an Instagram preview, a caption, `publish_readiness`, and media classifications while retaining `shadow_only: true` and making no network request.

**Red:** Prove data URLs are preview-only, HTTPS is retrievable, absent media is blocked, and no result implies a live send.
**Green:** Add the smallest media classification and readiness projection.
**Commands:** `node --test tests/publishing/channel-drafts.test.mjs`; `npm run test:publishing`.
**Commit:** `feat: add safe Instagram shadow previews`

## Task 4: Add Dexter's non-blocking four-channel bridge (TDD)

**Files:**
* Add `core/publishing/bridges/dexter-shadow.mjs`
* Add `tests/publishing/dexter-shadow-bridge.test.mjs`
* Modify `netlify/functions/publishing-shadow.mjs`
* Narrowly modify `index.html` only after regression coverage identifies the exact existing success seam

**Interface:** normalized Dexter product submission defaults/limits channels to Facebook Page, Facebook Marketplace, Instagram, and Website. Browser helper catches and reports Core failure without changing Square/Facebook success.

**Red:** Prove channel set, `live_sent: false`, all-settled independence, tenant enforcement, and fallback success despite bridge failure.
**Green:** Add the best-effort bridge at a post-success seam.
**Commands:** `node --test tests/publishing/dexter-shadow-bridge.test.mjs tests/publishing/publishing-shadow-endpoint.test.mjs`; `npm run test:publishing`.
**Commit:** `feat: bridge Dexter products to publishing shadow`

## Task 5: Add value instrumentation and morning runbook (TDD where practical)

**Files:**
* Add `core/publishing/metrics/shadow-value.mjs`
* Add `tests/publishing/shadow-value.test.mjs`
* Modify `netlify/functions/publishing-shadow.mjs`
* Add `docs/INSTAGRAM_CONNECTION_RUNBOOK.md`
* Add/update `docs/OVERNIGHT_REPORT_2026-09-17.md`

**Interface:** response/persisted run includes factual counts, success/failure split, preparation duration, and estimated workflow steps saved using a documented deterministic heuristic; no revenue attribution.

**Commands:** focused test; `npm run test:publishing`; `git diff --check`; secret-pattern scan; full branch diff review.
**Commit:** `feat: measure publishing preparation value`; `docs: add Instagram handoff and overnight report`

## Task 6: Final safety verification and handoff

Run fresh: `npm run test:publishing`, any additional focused tests, `git diff --check`, status, Auto City diff check, protected-flow diff review, and credential scan. Confirm every Core result is `live_sent: false`, working tree is clean, and all intended commits exist. Create a draft PR targeting `platform-v1`; do not merge or deploy.
