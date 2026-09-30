# Narleo Production Cutover Runbook

Status: PRE-PRODUCTION / NO-GO until explicit approval

Last verified: 2026-09-30

This runbook is for the first Narleo platform release to the existing Netlify Production site. It does not authorize a merge or Production deploy.

## Verified current Production baseline

- Production branch: `main`
- Current deployed Production commit: `f3dcaac89ab866ae2e08755bea04c5e583e59acc`
- Customer application hostname: `https://app.narleobit.com`
- DNS: verified
- TLS: verified
- Current Production application is still the pre-Narleo/main application.
- Current Production deploy has no Netlify Database branch attached yet.
- Current Production commit contains no `netlify/database/` tree and no `package.json`; the old Production application does not use Netlify Database.
- Preview #17/Dexter must remain untouched.

Netlify Database is provisioned automatically when code using `@netlify/database` is deployed. Production deploys use the main database. Migrations in `netlify/database/migrations/` are applied immediately before a Production deploy is published; a failed migration blocks publication.

Because this is the first Production database cutover, there is no pre-existing Production database to snapshot before the first migration run. After the first successful Production database publish, Netlify automatically creates an on-publish backup, and subsequent backups can be restored from the Database dashboard.

## Git topology

Feature work:
`feat/facebook-self-service-onboarding -> platform-v1` via PR #18.

Production release:
`platform-v1 -> main` via a separate release PR.

Merging PR #18 must not be treated as permission to merge the later Production release PR.

## Completed Production preflight

### Domain / origin
- [x] `app.narleobit.com` attached to the Netlify project.
- [x] DNS verified.
- [x] TLS verified.
- [x] `GROWTHWISE_PUBLIC_ORIGIN=https://app.narleobit.com`.
- [x] Transactional sender configured as `Narleo <signin@narleobit.com>`.

### OAuth redirect allowlisting
- [x] Facebook Production OAuth callback added; Preview callback preserved.
- [x] Instagram Production OAuth callback added; Preview callbacks preserved.
- [x] Microsoft Production OAuth callback added; Preview callback preserved.
- [x] Square Production OAuth callback added; Sandbox callback preserved.

### Production connector configuration
The following Production values are present without exposing their values:
- [x] Facebook app ID / app secret.
- [x] Facebook OAuth state, binding, and credential-encryption secrets.
- [x] Instagram app ID / app secret.
- [x] Instagram OAuth state, binding, and credential-encryption secrets.
- [x] Microsoft client ID / client secret.
- [x] Microsoft OAuth state, binding, and credential-encryption secrets.
- [x] Square environment set to Production.
- [x] Square Production Application ID / Application Secret.
- [x] Square OAuth state, binding, and credential-encryption secrets.
- [x] Meta webhook verification token.
- [x] Resend transactional email API key.
- [x] Existing OpenAI/admin/lead-ingest/Facebook Graph runtime settings still present.

### Meta webhook hardening
- [x] Facebook Page/Messenger webhook signatures use the Facebook app secret.
- [x] Instagram webhook signatures use the Instagram app secret.
- [x] Legacy single Meta secret remains fallback-only.
- [x] Cross-provider signatures are rejected.
- [x] CI green after split-secret hardening.

## Intentionally pending

### Stripe Live
Stripe Live activation remains paused while the legal/business setup is unresolved.

Production values intentionally remain unset:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `STRIPE_STARTER_PRICE_ID`
- `STRIPE_GROWTH_PRICE_ID`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_PORTAL_CONFIGURATION_ID`

Public paid self-service must not be treated as launch-ready until these are live values and live checkout/webhook acceptance is completed.

### Provider webhooks
Do not configure webhooks that require live Narleo functions until the Narleo platform code is deployed.

Pending after the endpoint exists:
- Meta inbound webhook: `https://app.narleobit.com/.netlify/functions/meta-webhook`
- Microsoft mail webhook/subscription callback: `https://app.narleobit.com/.netlify/functions/microsoft-mail-webhook`
- Stripe webhook: `https://app.narleobit.com/.netlify/functions/stripe-webhook`

## Database migration audit

The first Narleo Production database cutover contains exactly 29 ordered migrations.

Static release guards verify:
- exactly 29 migration directories;
- unique, timestamped migration directory names;
- every migration contains `migration.sql`;
- no migration uses `DROP TABLE`;
- no migration uses `TRUNCATE`;
- no migration uses `DELETE FROM`;
- critical table dependencies run in order;
- subscription `plan_started_at` backfill runs before `NOT NULL`;
- all Production callback/webhook function files referenced by the release checklist exist.

### Notable schema changes to re-check at cutover

1. `instagram_credentials`
   - Removes uniqueness from `account_binding_key` to allow the intended shared-account behavior.

2. `growthwise_subscriptions`
   - Adds `plan_started_at`.
   - Backfills existing rows from `created_at`.
   - Only then enforces `NOT NULL`.

3. Connector invitation/session allowed-list
   - Expands from Facebook/Instagram -> email -> website.
   - Existing connector constraints are dropped and replaced deliberately.

4. Website forms
   - Creates tenant-linked form routing.
   - A following migration intentionally removes the foreign key so built-in pilot businesses without a `growthwise_tenants` row are supported.

5. Lead outcomes
   - Expands the lead status constraint to include `won`.

6. Duplicate entitlement/marketing migration history
   - Later migrations are intentionally idempotent safety copies.
   - Do not delete or rename historical migration directories merely because SQL overlaps.

## Pre-merge database gate

Before the separate `platform-v1 -> main` release PR is merged:

1. Reconfirm current Production commit and that no unexpected Production deploy occurred.
2. Reconfirm PR #18 / `platform-v1` CI is green.
3. Confirm the Netlify Database dashboard/backup controls are available to the account role that will own Production after first publish.
4. Do not try to create a pre-cutover database snapshot: no Production database exists yet.
5. Do not manually initialize or manually apply the 29 migrations just to test Production.
6. Let the Production deploy provision the main database and own migration ordering.
7. If any migration fails, stop. Netlify should block publication; do not bypass, mark-applied, or manually alter the schema to force publication.
8. Confirm Stripe launch mode:
   - either Live Stripe is fully configured and accepted; or
   - public paid self-service remains explicitly out of launch scope.
9. Obtain explicit approval before merging the release PR.

## Release sequence

Only after all gates pass:

1. Merge PR #18 into `platform-v1`.
2. Verify `platform-v1` exact-head CI and Netlify validation.
3. Open a separate `platform-v1 -> main` Production release PR.
4. Review the release diff against the current Production commit.
5. Recheck Production environment presence without exposing secret values.
6. Confirm database rollback/restore posture.
7. Obtain explicit approval to merge the Production release PR.
8. Merge once.
9. Monitor Netlify build and all 29 migrations.
10. Do not retry a failed migration by editing Production manually.
11. After Ready, execute the smoke test below.

## Immediate Production smoke test

1. Open `https://app.narleobit.com` and confirm valid TLS.
2. Confirm Narleo branding rather than the old Dexter Production UI.
3. Confirm passwordless sign-in email delivery.
4. Confirm token exchange and persistent secure session.
5. Confirm tenant isolation.
6. Confirm subscription/entitlement state fails closed if billing is not launch-enabled.
7. Confirm customer channels page loads.
8. Confirm only intended launch connectors are available.
9. Confirm Facebook connection UI loads; do not connect Dexter's real Page for smoke testing.
10. Confirm Instagram connection UI loads; use only an approved test account if provider acceptance is required.
11. Confirm Microsoft connector UI loads; use only the dedicated test mailbox if acceptance is required.
12. Confirm Square connector uses Production configuration but do not connect Dexter merely for smoke testing.
13. Submit one controlled hosted website inquiry and verify tenant-bound inbox routing.
14. Confirm no automatic reply, post, DM, or customer message occurs.
15. Inspect logs for errors and confirm no credentials/tokens are emitted.
16. Configure/verify provider webhooks only after their Production endpoints are live.
17. If Stripe Live is launch-enabled, perform the separately approved low-risk billing acceptance test.

## Rollback

### Application failure before database migration
- Keep or restore the last known-good `main` deploy.

### Migration failure
- Netlify should block publication.
- Do not bypass the failed migration.
- Preserve logs and diagnose on a non-Production branch.

### Application failure after successful first database publish
- The old Production application does not use Netlify Database, so rolling application code back to the old `main` baseline can leave the newly provisioned database idle.
- Do not assume a code rollback reverses schema changes.
- Netlify creates an on-publish backup after a successful Production database publish; use the Database dashboard restore flow only if schema/data rollback is actually required.
- A restore replaces the Production database contents with the selected backup, so consider any post-backup data before restoring.

### Provider failure
- Disable a newly configured webhook only if needed to stop unsafe traffic.
- Do not rotate credentials as a generic rollback step.
- Do not disconnect customer accounts unless necessary.

### Billing failure
- Keep/disable the live billing entry point as appropriate.
- Never delete customers or subscriptions as a rollback shortcut.

## Go/no-go

Current status: **NO-GO for Production release**.

Remaining launch-critical decisions:
- Stripe Live / public paid signup timing.
- Database restore/rollback mechanism confirmation immediately before first Production database cutover.
- Provider webhook setup after live endpoints exist.
- Explicit approval for each Production merge/deploy step.
