# Instagram connection operations runbook

## Scope and hard boundaries

This runbook operates the identity-only Instagram connection for the Meta app **GrowthWise Social**. The implementation requests exactly `instagram_business_basic`. Instagram publishing remains disabled: do not create media containers, publish media, configure webhooks, automate messages/comments, or perform another Meta mutation. Publishing Core remains shadow-only with `live_sent: false`.

The browser receives only safe connection state and display identity. OAuth codes, provider account IDs, app secrets, access tokens, encryption material, database rows, and raw provider errors remain server-side. Never create or paste an Instagram access token for this flow.

## Fixed production origin and callback

Paul verified the stable Netlify production origin (not a deploy preview or branch deploy):

```text
GROWTHWISE_PUBLIC_ORIGIN=https://euphonious-beijinho-db4b4d.netlify.app
```

Register this exact callback URI in **GrowthWise Social**:

```text
https://euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/instagram-oauth-callback
```

Scheme, hostname, path, and trailing-slash behavior must match exactly. Do not derive either value from request headers and do not substitute a preview URL. This runbook does not authorize a deployment or a Meta-console change.

## Server-only environment configuration

Configure values only in Netlify's server environment controls, with the narrowest appropriate site/deploy scope. Never put values in browser/client JSON, frontend JavaScript, Git, issue/PR text, logs, screenshots, analytics, URLs, or support chat. The required variable names are:

* `GROWTHWISE_ADMIN_KEY`
* `GROWTHWISE_PUBLIC_ORIGIN`
* `GROWTHWISE_INSTAGRAM_APP_ID`
* `GROWTHWISE_INSTAGRAM_APP_SECRET`
* `GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET`
* `GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET`
* `GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY`

The optional development-only legacy bridge also reads `CONTEXT` and `GROWTHWISE_INSTAGRAM_LEGACY_FALLBACK_BUSINESSES`; its exact constraints are documented under **Legacy fallback and rollback** below.

`NETLIFY_DB_URL` is supplied by the Netlify Database runtime; do not commit or expose it. Verify that the target deploy context is linked to the intended database without printing the connection string.

Use three independent cryptographic secret families:

1. **OAuth state:** at least 32 random bytes represented as a high-entropy UTF-8 secret for HMAC authentication.
2. **Account binding:** a different secret of at least 32 random bytes represented as a high-entropy UTF-8 secret.
3. **Credential encryption:** exactly 32 random bytes encoded as unpadded base64url for AES-256-GCM. Each record's `encryption_key_version` identifies the key used to encrypt it.

Do not reuse a value between these families. Record version identifiers and encoding in the restricted operator secret inventory, not in this repository. Before deployment, validate configuration in the intended non-production deploy context and confirm that missing/malformed configuration fails closed without printing any value.

**Rotation is not an available operator action in the current runtime.** It loads only the current `v1` value for each secret family and has no configured previous-key input or completed binding/re-encryption migration. Keep the existing current values in place. Before rotating any of them, land separately reviewed code, tests, environment-version naming, and—where durable bindings or ciphertext are affected—a transactional data migration and rollback plan. OAuth-state rotation must account for the ten-minute pending-flow window; account-binding rotation must reconcile every owner and conflict; credential-key rotation must re-encrypt and verify every active row. Do not replace an existing current value first and assume old records remain readable.

## Database migration guardrails

The OAuth security store is PostgreSQL-backed through `@netlify/database`; it must not use Netlify Blobs. The schema is created by `netlify/database/migrations/20260917173000_instagram-oauth/migration.sql` and amended by `netlify/database/migrations/20260920095500_allow-shared-instagram-accounts/migration.sql`, using Netlify's required `<number>_<lowercase-slug>/migration.sql` layout.

* `instagram_oauth_transactions` keeps immutable tenant/return-destination identity and one-time status transitions.
* `instagram_credentials` keeps one encrypted credential row per GrowthWise business. The same verified Instagram account may be authorized separately for more than one business; each tenant retains its own encrypted credential and OAuth lifecycle.
* `account_binding_key` remains a cryptographic identity check for the connected Instagram account, but it is intentionally not unique across businesses.

Before any production deployment:

1. Use an isolated, explicitly authorized Deploy Preview database branch. Netlify automatically applies the checked-in migration before the preview acceptance test runs.
2. Review the migration and take the database backup/rollback precaution required by the current Netlify Database procedure.
3. Confirm the Deploy Preview migration completed automatically. The acceptance test must not apply migration SQL itself or drop application tables, triggers, or functions.
4. Verify the business primary key, absence of a cross-tenant uniqueness constraint on `account_binding_key`, status checks, and transaction-identity immutability in that isolated database.
5. Run `node --test tests/integration/instagram-database.test.mjs` with `CONTEXT=deploy-preview` and `INSTAGRAM_DATABASE_INTEGRATION=isolated-deploy-preview` in that preview context. It must prove one winner for concurrent claims, rollback behavior, shared-account support across separate tenants, encryption-at-rest, scoped cleanup, tenant isolation, and same-business reconnect.
6. Record the exact migration revision and test evidence without recording rows, ciphertext, connection strings, or secrets.
7. Only after review may the normal deployment process apply the same checked-in migration. This implementation task does not apply a migration or initialize a production database.

When no isolated database is available, report the real-database suite as **NOT TESTABLE**. Do not report it as passing, fall back to Blobs, relax a constraint, or deploy merely to obtain a database.

## Pre-deployment verification

Do not begin interactive acceptance until all of the following are true:

1. The runtime is Node `>=22.12.0`, the lockfile resolves `@netlify/database` `2.0.1`, and the migration was validated in an isolated database.
2. The production origin and exact callback above agree with the restricted Netlify and GrowthWise Social settings.
3. GrowthWise Social uses Instagram API with Instagram Login for professional Business/Creator accounts and grants only `instagram_business_basic` for this milestone.
4. `growth.wise1` is a professional test account authorized for the app. It is acceptance data, never an allowed-account constant or committed provider ID.
5. Start, callback, store, crypto, health, UI, publishing-regression, and secret-leakage tests pass. The protected Auto City/Facebook files are unchanged.
6. No Instagram publishing endpoint, container operation, webhook, or external mutation has been added; shadow records still have `live_sent: false`.
7. Logs and monitoring are configured to record only safe categories, timestamps, and correlation IDs—not request query strings, headers/bodies, state values, provider bodies, ciphertext, or credentials.

## First manual acceptance: `growthwise-dev`

Perform this manually only after an approved non-production deployment and Meta tester window. Do not run it as part of this code task.

1. Open the GrowthWise development integration page at `/instagram-dev.html`.
2. Enter the existing beta administrator key only into the page's intended session control. Do not put it in a URL or capture it in evidence.
3. Press **Connect Instagram** for the server-authorized `growthwise-dev` tenant.
4. At **GrowthWise Social**, select and authorize the professional `growth.wise1` tester account. Grant only the requested identity access.
5. Allow the server callback to claim the transaction once, exchange the code server-side, and verify the professional identity with the resulting long-lived token. The token-authenticated `/me` `user_id` and `username` are the authoritative GrowthWise account-binding identity; the authorization-code exchange `user_id` is provider metadata and may use a different identifier namespace. The server then transactionally stores the encrypted credential/account binding.
6. Confirm the server-selected return is exactly `/instagram-dev.html?instagram=connected`. The query value is only a hint; the page must immediately remove it and must not infer success from it.
7. Allow the page to perform the authoritative authenticated health request for `growthwise-dev`.
8. Confirm the UI says `Connected to @growth.wise1` and exposes no account ID, token metadata, provider response, or secret.
9. Refresh health once and confirm the same safe result. Do not create or paste an access token and do not test publishing.

If the callback is replayed, only the first valid pending transaction may reach provider exchange. A replay must fail closed and must not change the credential.

## Dexter acceptance through the reusable component

For Deploy Preview acceptance, the Dexter page's current beta unlock also loads Square sandbox data. Ensure the preview context has the existing `SQUARE_SANDBOX_TOKEN` available to Functions before testing; otherwise the page can report a generic server-configuration error before the Instagram flow is attempted.


Dexter uses the same UI component and endpoints—never a Dexter-specific OAuth implementation.

1. Confirm Dexter's selected Instagram account is professional and eligible for GrowthWise Social testing.
2. Load the existing Dexter application at `/` with the server-authorized `dexters-hats` context.
3. Press **Connect Instagram**, authorize the intended professional account, and confirm the callback uses the immutable `dexters-hats` transaction.
4. Confirm the only server-selected return destination is `/?instagram=connected`, the hint is removed, and authoritative health is fetched.
5. Verify the safe connected username before recording acceptance. Do not enable a live channel or change the existing Square/Facebook workflow.

## Health states and reconnect

The authenticated health response, not the callback query, is authoritative:

* **Not Connected** — no stored OAuth credential exists and no explicitly permitted development fallback applies. The safe action is **Connect Instagram**.
* **Connected** — the encrypted credential is usable, current identity verification succeeded, and the verified identity matches both the tenant-bound encrypted data and account-binding key. The UI may show only `Connected to @username`, safe display name, and check time.
* **Needs Attention** — the credential is expired, revoked, corrupt, incomplete, scope-deficient, identity-mismatched, unverifiable, or temporarily cannot be verified. The UI gives a generic **Reconnect** action and never echoes provider errors.

Reconnect creates a new one-time transaction and follows the same server-side flow. A business may update its credential for the same verified account. The same Instagram account may also be independently authorized for another GrowthWise business; this creates a separate tenant-scoped encrypted credential rather than sharing a credential row. Reconnect must not use caller-supplied account identity or return destination, and one tenant must never read, overwrite, decrypt, or revoke another tenant's credential.

## Failure triage

Use a correlation ID and safe event category only. Never ask Paul or a customer to send tokens, codes, callback URLs, secrets, database rows, or provider payloads.

| Symptom | Safe checks and action |
|---|---|
| Start rejected | Confirm same-origin request, non-empty administrator-key configuration, exact allowlisted tenant, server configuration presence, and rate-limit status. Do not inspect/log the submitted key. |
| Provider cancellation | Expect the fixed `cancelled` hint, remove it, then fetch health. Start again only at the user's request. |
| Invalid/expired/replayed state | Confirm server time and database availability. Start a fresh flow; never reset a transaction to pending or exchange the old code manually. |
| Callback attention | Use only the normalized failure category. Check app/tester eligibility, exact callback, database health, and provider availability without exposing the provider response. |
| Same Instagram account used by multiple businesses | Allowed. Confirm each business completed its own OAuth flow and has its own tenant-scoped encrypted credential. Investigate only if one tenant can read or modify another tenant's record. |
| Needs Attention after prior success | Retry read-only health after a temporary outage. If expiry, revocation, identity mismatch, scope loss, or decryption failure persists, reconnect. Never declare Connected from cached UI state. |
| Database or crypto ambiguity | Fail closed. Preserve records for restricted investigation; do not switch to Blobs, plaintext, a legacy token, or a check-then-write workaround. |

Provider timeouts/rate limits do not prove revocation. Keep encrypted records, report **Needs Attention**, and retry health according to operational policy.

## Legacy fallback and rollback

Stored OAuth credentials are primary. Legacy token/account environment references are considered only when all of these exact runtime conditions hold: `CONTEXT` equals the literal `dev`; `GROWTHWISE_INSTAGRAM_LEGACY_FALLBACK_BUSINESSES` is a comma-separated list containing the exact requested `business_id`; that client's registry entry contains both legacy environment-variable references; and the database lookup returns no stored credential. Whitespace around list entries is ignored. An absent, empty, differently cased, or non-`dev` `CONTEXT` disables fallback. An absent list or a tenant not explicitly listed also disables it.

Set those names only in Netlify's server environment controls. `GROWTHWISE_INSTAGRAM_LEGACY_FALLBACK_BUSINESSES` contains business IDs, not token values. Never enable or resume fallback after a stored row is corrupt, expired, revoked, partial, mismatched, or otherwise bad; any stored-row or ambiguous database/decryption failure returns **Needs Attention** and must not activate legacy credentials. Never copy a legacy token through the browser.

For an application rollback:

1. Disable/hide the OAuth connection UI and disable the OAuth start route at the operational boundary.
2. Leave callback handling fail-closed so no unclaimed transaction reaches exchange; do not reset processing/consumed transactions.
3. Retain encrypted credential and transaction records for controlled recovery/audit. Do not decrypt/export them or release account ownership as an incidental rollback step.
4. Keep Publishing Core shadow-only, Instagram publishing/webhooks disabled, and Dexter Square/Facebook behavior unchanged.
5. Preserve legacy fallback as development-only under its explicit flag; never turn it on to mask a bad stored record.
6. Diagnose, test in an isolated context, and use the normal reviewed redeployment path. A rollback does not authorize production data mutation.

## Database acceptance evidence

On 2026-09-18, Deploy Preview #12 ran the temporary synthetic PostgreSQL acceptance harness against its isolated Netlify Database branch and validated the original one-account/one-business design. On 2026-09-20, the product policy changed to permit the same Instagram account to be authorized independently for multiple GrowthWise businesses. Migration `20260920095500_allow-shared-instagram-accounts` removes the obsolete cross-tenant uniqueness constraint while retaining one credential row per business and tenant-bound encryption.

Fresh acceptance for this amendment must prove that two businesses can connect the same professional Instagram account, that each receives a separate encrypted credential, and that neither tenant can read or modify the other's credential. Instagram publishing, media containers, webhooks, messaging, and comment automation remain disabled.
