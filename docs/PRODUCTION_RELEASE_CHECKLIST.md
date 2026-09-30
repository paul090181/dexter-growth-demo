# Narleo Production Release Checklist

Status: planning / pre-production only

Canonical production architecture:

- Public website: `https://narleobit.com`
- Customer application: `https://app.narleobit.com`
- Internal/code name: GrowthWise
- Customer-facing brand: Narleo / Narleo BIT
- Production branch: `main`
- Staging/integration branch: `platform-v1`

No Production change should occur without Paul's explicit approval.

## 1. Release topology

Current Netlify Production deploys from `main`.

PR #18 targets `platform-v1`, so merging PR #18 does **not** itself publish Production.

Production cutover is a separate release PR:

`platform-v1 -> main`

The release PR must pass CI and Netlify validation before merge.

## 2. Canonical production origin

Set the Production application origin to:

`https://app.narleobit.com`

Production Netlify variable:

`GROWTHWISE_PUBLIC_ORIGIN=https://app.narleobit.com`

Do not use a Deploy Preview hostname as the Production origin.

Before configuring DNS:
1. Add `app.narleobit.com` as the custom domain for the Narleo application in Netlify.
2. Use the exact DNS target Netlify supplies.
3. Configure that DNS record at the registrar/DNS provider.
4. Wait for TLS/certificate readiness.
5. Confirm `https://app.narleobit.com` resolves to the intended Production site.
6. Keep `narleobit.com` available for the public marketing site.

## 3. Provider callback and webhook URLs

After `app.narleobit.com` is active, provider dashboards should use these exact Production URLs.

### Facebook Page OAuth

`https://app.narleobit.com/.netlify/functions/facebook-oauth-callback`

### Meta inbound webhook

`https://app.narleobit.com/.netlify/functions/meta-webhook`

### Instagram OAuth

`https://app.narleobit.com/.netlify/functions/instagram-oauth-callback`

### Microsoft mail OAuth

`https://app.narleobit.com/.netlify/functions/microsoft-mail-oauth-callback`

### Microsoft mail webhook

`https://app.narleobit.com/.netlify/functions/microsoft-mail-webhook`

### Square OAuth

`https://app.narleobit.com/.netlify/functions/square-oauth-callback`

### Stripe webhook

`https://app.narleobit.com/.netlify/functions/stripe-webhook`

Provider configuration must be completed against the Production hostname, not a Deploy Preview URL.

## 4. Production environment matrix

Populate Production values only. Do not copy preview/test secrets blindly.

### Core / passwordless access

- `GROWTHWISE_PUBLIC_ORIGIN`
- `GROWTHWISE_TRANSACTIONAL_EMAIL_API_KEY`
- `GROWTHWISE_TRANSACTIONAL_EMAIL_FROM`

Planned sender:

`Narleo <signin@narleobit.com>`

### Stripe live billing

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID` — Founding plan, if retained
- `STRIPE_STARTER_PRICE_ID`
- `STRIPE_GROWTH_PRICE_ID`
- `STRIPE_PRO_PRICE_ID`
- `STRIPE_PORTAL_CONFIGURATION_ID`

All must belong to the live Stripe environment. Never use sandbox Price IDs, webhook secrets, or secret keys in Production.

### Facebook self-service

- `GROWTHWISE_FACEBOOK_APP_ID`
- `GROWTHWISE_FACEBOOK_APP_SECRET`
- `GROWTHWISE_FACEBOOK_OAUTH_STATE_SECRET`
- `GROWTHWISE_FACEBOOK_ACCOUNT_BINDING_SECRET`
- `GROWTHWISE_FACEBOOK_CREDENTIAL_ENCRYPTION_KEY`
- `META_WEBHOOK_VERIFY_TOKEN`

### Instagram self-service

- `GROWTHWISE_INSTAGRAM_APP_ID`
- `GROWTHWISE_INSTAGRAM_APP_SECRET`
- `GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET`
- `GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET`
- `GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY`

### Microsoft mail

- `GROWTHWISE_MICROSOFT_CLIENT_ID`
- `GROWTHWISE_MICROSOFT_CLIENT_SECRET`
- `GROWTHWISE_MICROSOFT_MAIL_OAUTH_STATE_SECRET`
- `GROWTHWISE_MICROSOFT_MAIL_ACCOUNT_BINDING_SECRET`
- `GROWTHWISE_MICROSOFT_MAIL_CREDENTIAL_ENCRYPTION_KEY`

### Square self-service

- `GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT=production`
- `GROWTHWISE_SQUARE_OAUTH_APPLICATION_ID`
- `GROWTHWISE_SQUARE_OAUTH_APPLICATION_SECRET`
- `GROWTHWISE_SQUARE_OAUTH_STATE_SECRET`
- `GROWTHWISE_SQUARE_ACCOUNT_BINDING_SECRET`
- `GROWTHWISE_SQUARE_CREDENTIAL_ENCRYPTION_KEY`

### Existing runtime settings

Verify these remain intentionally configured and correctly scoped:

- `OPENAI_API_KEY`
- `GROWTHWISE_ADMIN_KEY`
- `GROWTHWISE_LEAD_INGEST_KEY`
- `FACEBOOK_GRAPH_VERSION`

Do not expose values in GitHub, issue comments, chat, screenshots, or documentation.

## 5. Stripe live setup

Before enabling paid self-service:

1. Connect/authorize the live Stripe account for Narleo.
2. Create or verify live products and recurring Prices for each launch plan.
3. Configure the live Customer Portal.
4. Create the Production webhook destination:
   `https://app.narleobit.com/.netlify/functions/stripe-webhook`
5. Subscribe only to the billing events supported by the application.
6. Store the Production signing secret in Netlify Production only.
7. Verify no sandbox IDs exist in Production variables.
8. Run a deliberate low-risk live billing acceptance test only after Production deployment and Paul's approval.

## 6. Provider production setup

### Meta / Facebook
- Add the exact Production OAuth redirect URI.
- Add/verify the Production webhook callback.
- Preserve explicit Page selection.
- Preserve tenant-bound Page binding.
- Keep publishing human-review-gated.
- Do not connect Dexter's real Page merely for Production smoke testing.
- Verify Messenger inbound separately if it is part of launch scope.

### Instagram
- Add the exact Production redirect URI.
- Confirm required publishing/messaging permissions.
- Verify a dedicated test professional account before customer rollout.

### Microsoft
- Add the exact Production redirect URI in the Entra app.
- Confirm delegated scopes remain limited to the intended mail integration.
- Verify webhook/subscription callback behavior against the Production origin.

### Square
- Use a Production Square OAuth application/configuration.
- Set `GROWTHWISE_SQUARE_OAUTH_ENVIRONMENT=production`.
- Add the exact Production redirect URI.
- Do not use sandbox credentials in Production.

## 7. Database production checkpoint

The current Production baseline predates the Narleo platform database.

The release includes 29 Netlify Database migrations relative to current `main`.

Before the Production release PR is merged:

1. Confirm Production database state and migration baseline.
2. Confirm the current Production baseline still has no Netlify Database attached.
3. Confirm Netlify will automatically provision/use the main Production database on the first Narleo database deploy.
4. Because no Production database exists yet, do not require or fabricate a pre-cutover database snapshot. Confirm backup/restore controls for use after first successful publish.
5. Review migration order.
6. Specifically re-confirm:
   - subscription plan-start backfill / NOT NULL change
   - connector allowed-list constraint changes
   - Facebook Page OAuth/Page-selection schema
   - tenant business-type constraint
   - website-form schema
   - website-form pilot-support foreign-key removal
   - lead `won` status constraint
7. Do not manually apply preview migrations to Production.
8. Let the Production deploy own database provisioning and migration order.
9. If a migration fails, Netlify should block publication; do not bypass it to force publication.
10. After the first successful Production database publish, verify the automatic on-publish backup is visible in the Database dashboard.

## 8. Production release gate

Before opening the release PR `platform-v1 -> main`:

- PR #18 merged into `platform-v1` and verified.
- `platform-v1` green.
- `app.narleobit.com` configured and TLS-ready.
- Production environment matrix completed.
- Production provider redirects/webhooks configured.
- Stripe live configuration completed if billing launches immediately.
- Production database restore point confirmed.
- Facebook/Meta launch scope decided.
- Microsoft launch scope decided.
- Square launch scope decided.
- No unresolved P0/P1 security or tenant-isolation issue.
- Paul explicitly approves opening/merging the Production release.

## 9. Production smoke test

Immediately after Production publishes:

1. Open `https://app.narleobit.com`.
2. Confirm TLS and Narleo branding.
3. Confirm passwordless sign-in email delivery.
4. Confirm one-time token exchange and persistent secure session.
5. Confirm tenant isolation.
6. Confirm subscription/entitlement status.
7. Confirm customer channels page loads.
8. Verify only intended launch connectors are available.
9. Verify Facebook connection health using a test Page if applicable.
10. Verify Microsoft connection using a test mailbox if applicable.
11. Verify Square connection using an authorized test merchant if applicable.
12. Verify hosted website inquiry reaches the correct inbox.
13. Confirm no automatic customer reply or social post occurs.
14. Confirm production logs contain no secrets/tokens.
15. Verify Stripe webhook health and billing state if live billing is enabled.

## 10. Rollback posture

Code rollback:
- Revert/redeploy the last known-good `main` commit if the application layer fails.

Database:
- Do not assume reverting code reverses migrations.
- Use the confirmed Production database restore mechanism if schema/data rollback is required.
- Preserve webhook/event audit records unless the restore itself requires otherwise.

Providers:
- Disable or remove newly added Production webhook destinations only if required to stop unsafe traffic.
- Do not rotate credentials simply as a generic rollback step.
- Do not disconnect customer accounts unless necessary.

Billing:
- If billing behavior is unsafe, disable the Production billing entry point/webhook deliberately.
- Do not delete Stripe customers/subscriptions as a rollback shortcut.

## 11. Go/no-go rule

Production remains **NO-GO** until every launch-critical item above is verified and Paul explicitly authorizes the release.

Preview #17/Dexter must remain protected throughout the release process.
