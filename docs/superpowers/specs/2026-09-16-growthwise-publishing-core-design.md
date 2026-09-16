# GrowthWise Publishing Core v1 — Design Specification

**Date:** 2026-09-16  
**Status:** Approved design; implementation not started  
**Scope:** First shared GrowthWise subsystem  
**Primary pilots:** Auto City (Automotive) and Dexter's Hats (Retail)

## 1. Purpose

GrowthWise Publishing Core is the first reusable subsystem extracted from the existing Automotive and Retail pilots. Its purpose is to let multiple businesses and multiple industry packs publish or prepare content for many external channels through one shared, business-safe, configurable workflow.

The subsystem must prove that GrowthWise can support distinct industries without permanent client-specific forks. It must preserve the current working Auto City and Dexter flows while the new core is validated in shadow mode.

Publishing Core v1 is deliberately narrower than the full GrowthWise platform. It does **not** attempt to build the full CRM, property-management product, service-business product, billing system, or complete production integrations for every channel. It establishes the reusable publishing foundation those future capabilities can use.

## 2. Platform Direction

GrowthWise is designed as a multi-client business platform first and a collection of industry experiences second.

The long-term platform has four layers:

1. **Core** — business identity, users, roles, contacts, assets/offerings, work, communications, media, AI, automation, analytics, and audit history.
2. **Shared capabilities** — publishing, CRM, reviews, campaigns, scheduling, websites, payments/commerce adapters, import/export, and related reusable services.
3. **Industry packs** — Automotive, Retail, Property Management, Local Services, Beauty/Appointments, and future verticals.
4. **Client configuration** — per-business modules, integrations, branding, automation policies, permissions, and rules.

Client-specific behavior should be expressed through configuration or reusable extensions whenever practical. Permanent client forks are not part of the target architecture.

## 3. Tenancy and Data Isolation

Every GrowthWise-owned record must belong to exactly one business through a permanent `business_id`.

Access follows this chain:

**User -> Business Membership -> Role -> Allowed Modules/Actions -> Business-Owned Data**

Requirements:

- Every publishable record, campaign, draft, job, audit event, credential reference, and result carries `business_id`.
- Users may belong to one or more businesses, but access is explicitly granted per membership.
- A business can only query or mutate its own records.
- Credentials and external account connections are isolated per business.
- Audit history records who or what performed each action.
- One client's failed integration or backlog must not block another client.
- During the pilot phase, Auto City and Dexter may remain on separate deployments for additional safety, while the data model remains multi-tenant-ready.
- The long-term database should enforce tenant isolation at the data layer, not only in the UI. Row-level security or an equivalent server-side enforcement mechanism is the target.

## 4. Source of Truth

GrowthWise is the default source of truth whenever practical.

Each integration can operate in one of three ownership modes:

- **GrowthWise Master** — GrowthWise owns the canonical record and pushes changes outward.
- **External Master** — an external service remains authoritative for that domain and GrowthWise imports/syncs from it.
- **Bidirectional** — both sides may update, using explicit conflict rules and audit history.

GrowthWise Master is the default for new GrowthWise-managed business data. External Master and Bidirectional exist for migration needs and platforms that must remain authoritative for specific functions.

## 5. Publishing Core Scope

Publishing Core v1 must support these concepts:

- Canonical master publishing package
- Protected verified facts
- Media package
- Channel registry
- Per-channel drafts
- Client automation policies
- Role/permission checks
- Direct / Assisted / Export delivery modes
- Independent channel jobs
- Retry and duplicate protection
- Human-readable failure handling
- Audit history
- Shadow-mode comparison against existing Auto City and Dexter flows

Publishing Core v1 must not require the current working Auto City or Dexter publishing code to be replaced before the new core passes validation.

## 6. Initial Channel Registry

The v1 registry contains all eleven channels from the start:

1. Facebook Page
2. Facebook Marketplace
3. Instagram
4. Website
5. eBay
6. Etsy
7. Pinterest
8. Craigslist
9. Mercari
10. TikTok
11. Google Business Profile

Facebook Marketplace is a distinct first-class channel, not a subtype of Facebook Page publishing.

The registry describes capability, not assumed availability. Each channel declares what GrowthWise can safely do for that channel at the current time.

Each channel declares a delivery mode:

- **Direct Publish** — GrowthWise uses a supported integration/API to publish or update directly.
- **Assisted Publish** — GrowthWise prepares the complete listing/post and guides or hands off to the user for the final platform action.
- **Export Only** — GrowthWise creates a complete package for external/manual use when direct or assisted automation is not appropriate.

A channel's mode can evolve without changing the Publishing Core contract.

For Facebook Marketplace specifically, the initial design must support an assisted/shadow workflow unless and until a supported direct integration is verified. Marketplace must still have its own automation settings, media rules, status tracking, category mapping, and error handling.

## 7. Master Package Model

Publishing begins with a normalized GrowthWise master package rather than channel-specific data.

A master package includes, at minimum:

- `business_id`
- source record type and source record ID
- item/asset/offering type
- title/name
- approved description or summary
- price and currency when applicable
- availability/inventory/status when applicable
- business/location information when applicable
- canonical URL when applicable
- ordered media collection
- verified facts
- flexible industry-specific attributes
- campaign objective/context
- source-of-truth metadata
- created/updated timestamps
- approval state

The shared package must remain vertical-neutral. Industry-specific data is stored in the flexible attributes/extension area and produced by vertical adapters.

Examples:

- Automotive maps VIN, year, make, model, trim, mileage, stock number, and other vehicle facts into the normalized package.
- Retail maps SKU, brand, size, color, variant, quantity, and related product facts.
- Future Property or Services packs may map their own domain fields without requiring channel adapters to understand those industries directly.

## 8. Fact Protection and AI Rules

Verified facts are protected from silent AI mutation.

AI may:

- rewrite tone and marketing language,
- shorten or expand copy,
- generate channel-specific calls to action,
- reorganize approved factual information,
- generate draft variants.

AI must not silently change factual fields such as price, VIN, mileage, SKU, quantity, address, availability, or another verified attribute.

If a channel-specific change would alter a protected fact, it requires an explicit approved override and must be recorded in audit history.

## 9. Master Package and Channel Drafts

GrowthWise creates one master package, then generates independently editable channel drafts.

The master package is the shared factual source. Each channel draft may vary in:

- title length and format,
- description style,
- hashtags or platform-specific copy,
- media selection/order,
- category mapping,
- calls to action,
- fields supported by the destination channel.

Editing a channel draft does not automatically change the master package. A user may deliberately promote a suitable change back to the master record through an explicit action.

## 10. Client Automation Model

Each client controls its own automation level.

Supported levels:

- **Manual** — GrowthWise prepares content but performs no publishing action.
- **Review & Approve** — GrowthWise prepares content and waits for an authorized user to approve it.
- **Automatic** — GrowthWise publishes or synchronizes automatically when the channel and client rules allow it.

Automation can be configured at multiple levels:

- business default,
- channel override,
- action override.

Example: a client may automatically sync website inventory, require approval for Facebook Page posts, and keep Facebook Marketplace assisted/manual.

## 11. Roles and Permissions

Initial roles:

- **Owner/Admin** — integrations, users, permissions, automation policies, settings, publishing, and full control.
- **Manager** — approve campaigns/listing changes, publish, and review analytics within granted modules.
- **Staff** — create/edit drafts, upload media, and perform allowed operational work, but no high-risk automation or integration changes unless granted.
- **View Only** — read access only.

Automation settings never bypass authorization. Both the client policy and the user's permission must permit the action.

## 12. Hybrid Architecture

Publishing Core uses a hybrid architecture:

### Shared core logic

Responsible for:

- master-package schema and validation,
- fact protection,
- channel registry and capability metadata,
- channel-draft generation contracts,
- automation policy evaluation,
- permission-check contracts,
- media normalization,
- orchestration rules,
- result normalization.

### Secure service layer

Responsible for:

- external credentials/secrets,
- authenticated business context,
- direct external publishing calls,
- job state,
- retry processing,
- audit persistence,
- tenant-safe access,
- integration-specific secure operations.

Sensitive publishing operations must not depend on browser-side secrets.

## 13. Component Boundaries

Target logical structure:

```text
core/
  publishing/
    master-package/
    channels/
    automation/
    media/
    orchestration/
    audit/

integrations/
  channels/
    facebook-page/
    facebook-marketplace/
    instagram/
    website/
    ebay/
    etsy/
    pinterest/
    craigslist/
    mercari/
    tiktok/
    google-business/

verticals/
  automotive/
    publishing-adapter/
  retail/
    publishing-adapter/
  property/
    publishing-adapter/   # contract/future placeholder only in v1
  services/
    publishing-adapter/   # contract/future placeholder only in v1

clients/
  auto-city/
  dexters-hats/

tests/
  publishing/
```

Key boundary rules:

- Core knows publishing concepts, not dealership or hat-store details.
- Vertical adapters know how to convert industry records into the canonical package.
- Channel adapters know external channel requirements, not Automotive/Retail internals.
- Client configuration determines enabled modules, integrations, permissions, automation levels, and branding.
- A channel adapter must never reach into arbitrary Automotive or Retail fields directly.

## 14. Channel Capability Registry

Each channel entry should describe capabilities rather than rely on hard-coded assumptions scattered across the app.

Capability metadata should cover, as applicable:

- channel ID and display name,
- current delivery mode,
- supported media types,
- media count/size/format limits,
- title/description constraints,
- price support,
- inventory/quantity support,
- location support,
- category requirements,
- video support,
- link support,
- update/delete support,
- status/read-back support,
- credential requirements,
- whether automatic actions are allowed,
- supported record/item types,
- adapter implementation status.

The registry must be able to represent a channel as known but not yet production-enabled.

## 15. Publishing Data Flow

Every publishing action follows this logical flow:

```text
Business-owned source record
        -> Vertical publishing adapter
        -> GrowthWise master package
        -> Fact/media validation
        -> Channel-specific drafts
        -> Client automation policy
        -> User/role permission check
        -> Channel job(s)
        -> Channel adapter
        -> Direct / Assisted / Export
        -> Result + audit history + analytics
```

One master package may create multiple independent channel jobs.

## 16. Independent Job Model

Publishing must not be all-or-nothing across channels.

Each channel job owns its own:

- business ID,
- package/draft reference,
- channel ID,
- status,
- attempt count,
- timestamps,
- last error/failure classification,
- external listing/post ID when available,
- idempotency/duplicate-protection key,
- approval state,
- result metadata.

Suggested statuses:

- Draft
- Waiting Approval
- Queued
- Processing
- Published
- Retry Scheduled
- Needs Attention
- Failed
- Removed

A failure in one channel must not stop unrelated channel jobs.

## 17. Failure Handling and Retries

Failures are classified into at least two broad groups:

### Technical failures

Examples:

- temporary platform outage,
- timeout,
- rate limit,
- expired/revoked credentials,
- transport/server error.

Temporary technical failures may be retried automatically when safe.

### Business-rule failures

Examples:

- missing required price,
- missing approved photo,
- unsupported category,
- required approval not granted,
- insufficient user permission,
- invalid client configuration.

Business-rule failures should stop immediately and explain the corrective action.

Requirements:

- retries must be safe and bounded,
- retries must not create duplicate posts/listings,
- no infinite retry loops,
- permanent or unresolved failures move to `Needs Attention`,
- user-facing errors should be understandable without technical knowledge,
- audit history records every attempt and outcome.

Example user-facing error:

> Marketplace needs a vehicle category before this listing can be prepared for publishing.

rather than exposing a raw low-level error as the primary message.

## 18. Duplicate Protection

Every external publish/update attempt that can be repeated must use a stable idempotency or duplicate-protection strategy.

The system should distinguish:

- first publish,
- retry of the same requested action,
- intentional republish/new campaign,
- update to an existing external listing.

A retry must not accidentally create a second external listing when the intended action was to recover the original request.

## 19. Shadow Mode

Publishing Core v1 begins in shadow mode.

In shadow mode:

- existing Auto City and Dexter production flows remain unchanged,
- Publishing Core receives representative source data,
- it creates master packages and channel drafts,
- it evaluates policies and permissions,
- it creates simulated channel jobs/results,
- it does not perform external live publishing unless a specific test adapter is explicitly enabled for controlled validation.

Shadow mode must make it possible to compare:

**Existing application output** vs. **Publishing Core output**

before migration.

## 20. Testing Strategy

Testing is layered.

### Layer 1 — Core unit tests

Cover:

- master-package validation,
- protected-fact handling,
- media validation,
- automation policy evaluation,
- permission checks,
- channel capability checks,
- duplicate-protection logic,
- job-state transitions.

### Layer 2 — Vertical fixture tests

At minimum:

- known Automotive vehicle fixture,
- known Retail product fixture.

Each must transform into a valid master package without losing required business facts.

Property and Services only need contract-level placeholder coverage in v1, not production feature implementation.

### Layer 3 — Channel draft tests

The same master packages are passed through all eleven channel definitions to confirm:

- correct capability handling,
- field requirements,
- media constraints,
- approval behavior,
- delivery-mode behavior,
- unsupported capability handling.

A registry entry may be tested even when its production adapter is not yet live.

### Layer 4 — Shadow comparison

Run Auto City and Dexter examples through both the current working flow and Publishing Core. Compare facts, media, copy, policies, and expected results.

### Layer 5 — Controlled live tests

Enable one proven channel/action at a time for one pilot client. Verify behavior before broadening.

## 21. Rollout Strategy

Migration is gradual, not a big-bang cutover.

Recommended progression:

1. Build and validate Publishing Core in shadow mode.
2. Confirm Automotive and Retail master-package transforms.
3. Confirm all eleven channel registry entries and draft behaviors.
4. Validate client isolation, permissions, automation policies, failure handling, and duplicate protection.
5. Enable one proven channel/action for one pilot client.
6. Observe results and rollback behavior.
7. Expand channel-by-channel and action-by-action.
8. Retire duplicate legacy publishing logic only after the replacement path is proven.

## 22. v1 Success Criteria

Publishing Core v1 is successful when:

- Auto City generates a valid Automotive master package.
- Dexter's Hats generates a valid Retail master package.
- All eleven channels exist as first-class registry entries.
- Facebook Marketplace exists separately from Facebook Page.
- Every channel declares Direct, Assisted, or Export behavior.
- Master facts are protected from silent AI mutation.
- Channel drafts are independently editable.
- Manual / Review & Approve / Automatic policies work at business, channel, and action levels.
- Role/permission checks work independently of automation settings.
- All records and jobs are business-scoped.
- One channel failure does not block another.
- retries are bounded and duplicate-safe.
- `Needs Attention` surfaces unresolved issues clearly.
- Automotive and Retail fixture tests pass.
- shadow output matches or improves on the existing flows without changing live behavior.
- no live external publishing occurs unless a specific adapter/action is explicitly enabled.

## 23. Explicit Non-Goals for v1

Publishing Core v1 does **not** include:

- complete production integrations for all eleven channels,
- a full Property Management product,
- a full Local Services product,
- SaaS billing/subscription management,
- migration of every existing GrowthWise feature into Core,
- replacement of Auto City or Dexter live publishing before validation,
- unsupported or hidden platform automation techniques,
- permanent client-specific forks.

## 24. Future Expansion

After Publishing Core proves the shared-platform model, GrowthWise can extract or build additional reusable subsystems one at a time, such as:

- Contacts/CRM,
- Communications,
- Reviews,
- Automation engine,
- Analytics,
- Scheduling,
- Website management,
- Commerce/payment adapters,
- additional industry packs.

The same architectural rule applies: shared business capabilities belong in GrowthWise Core/Shared Capabilities, while industry-specific behavior belongs in vertical packs and client-specific differences belong in configuration.

## 25. Design Decision Summary

The approved direction is:

- one GrowthWise multi-client platform,
- shared Core plus industry packs,
- strict `business_id` tenant isolation,
- configuration-driven onboarding,
- no permanent client forks,
- GrowthWise as default source of truth,
- hybrid shared-core + secure-service architecture,
- one master package plus per-channel drafts,
- client-controlled automation levels,
- role-based permissions,
- all eleven publishing channels represented from v1,
- Facebook Marketplace as a first-class separate channel,
- independent jobs with safe retries and duplicate protection,
- shadow-mode-first testing and gradual rollout.

This document defines the design only. Implementation must begin only after this specification is reviewed and approved, followed by a separate implementation plan.
