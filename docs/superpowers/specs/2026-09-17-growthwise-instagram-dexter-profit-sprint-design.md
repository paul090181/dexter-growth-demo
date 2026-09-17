# GrowthWise Instagram + Dexter Profit Sprint — Approved Design

**Date:** 2026-09-17
**Status:** Approved for implementation by the product owner
**Boundary:** Shadow preparation and connection readiness only; no new live action

## Product and profit objective

Make GrowthWise easier to justify as a recurring subscription by turning one normalized product entry into safe, reusable marketing drafts. The sprint should save retailer time, create additional marketing opportunities, reduce tool switching, and expose measurable preparation outcomes. It must not claim revenue attribution that GrowthWise cannot prove.

Commercial success is measured by products processed, channel drafts prepared, channels prepared per product, successful and failed preparations, approximate manual steps avoided, preparation duration, and connection health. Later pilots should also test setup completion, weekly active use, draft-to-publish conversion, and retained hours; sales attribution remains a future opportunity.

## Dexter-first rollout and fallback

Dexter's Hats is the first real retail business bridged into Publishing Core. Once the existing workflow has enough normalized product fields, it may submit a best-effort copy for four independent shadow outputs: Facebook Page, Facebook Marketplace, Instagram, and Website. Marketplace remains assisted/manual.

The existing Square and Facebook paths remain authoritative and unchanged. The bridge runs alongside them, never replaces them, and is non-blocking: a Core timeout, validation error, adapter failure, or persistence failure must not change the existing workflow's result. Auto City is outside this sprint and its live behavior must not change.

Every shadow result and response continues to report `live_sent: false`; configuration continues to require `shadow_mode: true` and `live_actions_enabled: false`. Each channel fails independently and creates its own auditable attempt.

## Reusable Instagram tenant architecture

Instagram is a shared Meta integration, not Dexter-specific code. A server endpoint accepts an authenticated GrowthWise business context, looks up only that business's server-side Instagram Login credential and account-binding references, verifies the directly authenticated professional account, and returns a redacted status projection. A Facebook Page is not required merely to connect. The same endpoint and state model support `growth.wise1`, Dexter, and later clients without code changes or embedded account IDs. A mismatched, non-professional, or ambiguous account response fails closed rather than selecting an account.

Initial states are:

* **Not Connected** — no credential/reference exists for this tenant.
* **Connected** — Meta verifies a discoverable professional account and required identity fields.
* **Needs Attention** — credentials are incomplete, expired/rejected, no eligible professional account is discoverable, or verification fails.

Connection mutation requires an owner/admin and a later interactive Meta OAuth flow. This sprint implements status/discovery verification and configuration guidance, but stops before authorization. It does not accept tokens from the browser.

## `growth.wise1` test-account strategy

`growth.wise1` is the first development/test account. Paul must make it a professional Business or Creator account, configure Instagram API with Instagram Login and the current `instagram_business_basic` permission plus redirect URI, complete authorization using the future server-side OAuth entry point, and verify that GrowthWise reports the authenticated username. No identifier is committed. Dexter later follows the identical direct Instagram professional-account flow.

No real Instagram post is authorized in this sprint. A separately approved live test and explicit account confirmation are required before any publishing implementation or external mutation.

## Credentials and security boundaries

* Access tokens, app secrets, account IDs, and credential payloads remain server-side.
* Tenant configuration contains only a secret environment-variable reference, never the secret itself.
* Client responses expose status, username/display identity, checked time, and safe remediation text—not tokens, raw Meta errors, or secret references.
* Requests are authenticated and the requested `business_id` must resolve to the same configured tenant.
* Connection checks are read-only Graph requests. Tokens are sent only in authorization headers and are never logged.
* Audit/value records retain tenant ownership. Protected product facts, roles, and existing Publishing Core permission checks remain enforced.

The sprint may reuse the existing administrator-key boundary because replacing authentication is explicitly out of scope. Production-grade OAuth state storage and membership-backed sessions are a future approved architecture decision.

## Instagram preparation and preview

Publishing Core prepares an Instagram-specific shadow payload and preview model containing caption, selected media metadata, account connection state, and readiness blockers. Preparation does not call Meta. The preview clearly distinguishes a locally previewable image from media eligible for later API retrieval.

Channel preparation remains independent: an Instagram blocker does not fail Facebook Page, Marketplace, Website, Square, or the legacy Facebook workflow.

## Media considerations

Current cleaned/uploaded product images are browser `data:` URLs. They are acceptable for a local preview and the existing direct-upload Facebook path, but they are **not** durable, publicly retrievable Instagram publishing URLs. Media normalization classifies `https:` media as remotely retrievable and `data:`/local media as preview-only. Instagram shadow output reports `media_hosting_required` until an eligible hosted URL exists and must never misrepresent base64 data as publish-ready.

**DECISION NEEDED:** Select tenant-isolated durable media storage, signed/public delivery policy, retention, deletion, and moderation rules before live Instagram publishing. This sprint will not create a large storage subsystem.

## No-live-publishing boundary

The implementation must not exchange an OAuth code, change an external account, create an Instagram media container, publish media, deploy, or modify production secrets. All Publishing Core work stays shadow-only. Work stops at either (a) interactive Meta authorization, (b) durable media-hosting choice, or (c) an explicitly approved live-publishing test.

## Stop conditions and scope control

Stop and document a blocker when work requires Paul/Dexter interaction, Meta app review, credentials, external settings, deployment, production data, or a new architecture. Do not build billing, CRM, broad messaging, other verticals, major authentication/data migrations, or autonomous live publishing. Continue on independent tests, safety, auditability, onboarding, health UX, and value measurement.

## Self-review

* **Ambiguity:** “Connect” in this milestone means a reusable server boundary, discovery/health capability, states, and tomorrow's OAuth instructions—not completing authorization tonight.
* **Contradictions:** Existing live Facebook remains allowed only through its unchanged legacy path; all new Core outputs remain shadow-only.
* **Placeholders:** No IDs, credentials, or business secrets are placeholders in source. Environment-variable names and documented redirect routes are configuration contracts.
* **Scope:** Durable media hosting, OAuth persistence, production membership authentication, and live publishing are explicitly deferred; the bounded implementation can be tested without them.
