# GrowthWise Instagram OAuth connection design

**Status:** approved, with PostgreSQL architecture amendment approved by Paul on 2026-09-17

**Date:** 2026-09-17

**Starting point:** `platform-v1` merge `9a8d71dcec5e508d875ed21fd2aeb2e0842bc3ba`

**Meta app:** GrowthWise Social

**First development account:** `growth.wise1` (configuration/test data only; never a production-code constant)

## Product outcome and phase boundary

A future GrowthWise customer should be able to press **Connect Instagram**, authorize a professional Instagram account, return to GrowthWise, and become securely connected without Paul creating tokens or editing code. The same capability must serve `growthwise-dev`, Dexter's Hats, and future tenants. This is a step toward a repeatable subscription product rather than a custom integration per business.

This phase connects and verifies identity only. It does **not** grant GrowthWise permission to publish, create media containers, configure webhooks, or perform any other Instagram mutation. Publishing Core remains shadow-only and every result remains `live_sent: false`.

## Current platform findings

* `instagram-connection.mjs` is a read-only, admin-key-protected health endpoint. It resolves a token and expected account ID through names stored in client JSON, calls the Instagram `/me` identity endpoint, and returns only safe state/identity fields. It already fails closed for an absent binding, a mismatched account, or an ambiguous response.
* `growthwise-dev.json` and `dexters-hats.json` point to tenant-specific token/account-ID environment variables. This is acceptable for a short development bridge but does not scale to self-service tenants.
* Publishing Core already uses Netlify Blobs named `growthwise-publishing-v1` and may continue doing so. Netlify Blobs' last-write-wins behavior and lack of built-in concurrency control are not sufficient for security-critical OAuth replay prevention or cross-tenant account ownership. By Paul's approved architecture amendment, the new Instagram OAuth subsystem instead uses Netlify Database/PostgreSQL and SQL transactions; this decision does not alter Publishing Core.
* The temporary security boundary is `GROWTHWISE_ADMIN_KEY`, supplied as `X-GrowthWise-Key`; the current browser keeps the entered key in session storage. It is not tenant-aware user authentication. This design uses it only because owner/session redesign is explicitly out of scope and requires replacement before broad production availability.
* Dexter's current Square/Facebook behavior and the existing Facebook publishing function are independent legacy paths and must remain unchanged.

## Decisions in this design

1. Use Instagram API with Instagram Login and request only the approved `instagram_business_basic` permission for connection identity/health. `instagram_business_content_publish` is excluded and requires a separately approved milestone and consent flow.
2. Keep OAuth codes, app credentials, and access tokens entirely server-side. Browser-visible values are limited to an opaque state value, Meta's authorization page, and a final safe result code.
3. Store short-lived OAuth transactions and encrypted tenant credentials in Netlify Database/PostgreSQL, behind a small adapter with dependency injection for tests. Use `@netlify/database`; transactions use one checked-out `db.pool` client for `BEGIN` / `COMMIT` / `ROLLBACK`, released in `finally`.
4. Use a 256-bit random opaque nonce plus an HMAC tag as `state`, backed by a ten-minute, one-use server record. The HMAC is defense in depth; no claims in browser state are trusted.
5. Encrypt the entire token payload with AES-256-GCM before persistence. Tenant and record identity are authenticated as additional authenticated data (AAD).
6. Make the OAuth credential store the primary lookup. Preserve the current environment-reference lookup only as an explicitly enabled development fallback during migration.
7. A professional Instagram account may be actively bound to only one GrowthWise business. A `UNIQUE NOT NULL` constraint on its independently keyed account fingerprint and a SQL transaction enforce that invariant without application-level check-then-write logic.

## Configuration and redirect URI

Required server environment values:

| Name | Purpose |
|---|---|
| `GROWTHWISE_INSTAGRAM_APP_ID` | Public app identifier used to build the Meta authorization request and during exchange. |
| `GROWTHWISE_INSTAGRAM_APP_SECRET` | Server-only code exchange and token lifecycle credential. |
| `GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET` | At least 256 random bits used only to authenticate short-lived opaque OAuth state values. |
| `GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET` | A distinct secret of at least 256 random bits used only to derive stable, non-enumerable Instagram account reverse-binding keys. |
| `GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY` | A versioned 32-byte key, encoded in an agreed deployment-safe form, used only for AES-256-GCM. |

Values are configured in the Netlify server environment, never committed, returned, logged, embedded in HTML/JavaScript, or copied to client JSON. Startup/configuration validation reports only a generic configuration error and the missing variable's non-secret name to restricted operational telemetry; it never reports a value.

The registered and supplied redirect URI must match exactly:

```text
https://euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/instagram-oauth-callback
```

Paul confirmed the stable production domain and approved the literal `GROWTHWISE_PUBLIC_ORIGIN=https://euphonious-beijinho-db4b4d.netlify.app`. Code constructs the callback from that value and the constant path; it never derives it from `Host`, forwarded headers, request parameters, or a caller-provided return URL. Preview/development origins need their own explicit allowlist/Meta registration. Nothing in this implementation task deploys to that origin.

## Server endpoints

### `POST /.netlify/functions/instagram-oauth-start`

`POST` avoids creating transactions through crawlers/prefetch. Under the temporary beta boundary, the GrowthWise frontend sends a same-origin authenticated request with the existing `X-GrowthWise-Key` header and a JSON body containing only `business_id`. The endpoint returns one safe authorization URL; after validating that response, the frontend navigates the browser to it. This preserves the repository's current header transport without putting the admin key in a form body or URL. Implementation should replace the beta key with an HttpOnly authenticated owner session in a future authentication milestone.

Processing order:

1. Require `POST`, an HTTPS/canonical-origin request, a same-origin `Origin` (and compatible `Sec-Fetch-Site` when present), `application/json`, a small body, and `Cache-Control: no-store`. Do not enable cross-origin reads. Reject before any transaction is created otherwise.
2. Compare the `X-GrowthWise-Key` header to non-empty `GROWTHWISE_ADMIN_KEY` in constant time. This authenticates an admin under the existing temporary boundary; it is not represented as final production owner authentication.
3. Normalize and validate `business_id` as a single safe key segment and resolve it through the server's explicit client registry. Confirm `client.business_id` matches and Instagram connection is allowed. Unknown or inconsistent tenants receive a generic rejection.
4. Generate 32 random bytes with a cryptographic RNG. Encode the nonce base64url without padding and compute `tag = HMAC-SHA-256(state_secret, "instagram-oauth-v1\n" + nonce)`. The browser state is `v1.<nonce>.<tag>`; it contains no tenant ID, return URL, or secret.
5. Insert a row in `instagram_oauth_transactions` keyed by `sha256(nonce)`. It contains immutable `business_id`, `return_destination_id`, `expires_at` (ten minutes), timestamps, and `status = 'pending'`; it contains neither raw browser state nor the admin key. A primary-key collision means generate a new nonce, never overwrite.
6. Build the provider authorization URL from fixed endpoints/configuration: app ID, exact callback URI, `response_type=code`, exactly `instagram_business_basic`, and the opaque state. Do not add PKCE by assumption. If later official acceptance returns or requires a concrete PKCE contract, stop and update this design intentionally.
7. Return `200 application/json` containing only `{ "authorization_url": "<server-built Meta URL>" }`, with `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, and no permissive CORS. The URL must use the fixed allowlisted Meta authorization origin and contain only the app ID, exact callback, minimum scope, response type, and opaque state. It must contain no admin key, app secret, access token, tenant/business claim, or arbitrary return URL. The frontend schema-checks that single field and its HTTPS Meta origin before assigning `window.location`; it never parses state or adds parameters.

Failures return a small JSON error from a fixed allowlist and never return or redirect to arbitrary input. No transaction is created when authentication or tenant validation fails.

### `GET /.netlify/functions/instagram-oauth-callback`

Meta invokes this endpoint with `code` and `state`, or an OAuth denial/error and `state`. It is intentionally not protected by the admin key; the pending server transaction authenticates the flow.

Processing order:

1. Accept only `GET`, enforce the configured callback origin/path, set `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and enforce strict query size/count limits. Reject provider fragments, duplicate parameters, malformed encodings, unexpected response combinations, missing state, or both `code` and provider error.
2. Parse the exact `v1.<nonce>.<tag>` format with length/alphabet limits. Recompute and constant-time compare the HMAC, then derive the transaction key. The row returned by the atomic claim, not browser input, supplies `business_id` and the return destination.
3. Atomically claim the transaction with one parameterized `UPDATE ... SET status = 'processing', processing_started_at = CURRENT_TIMESTAMP WHERE transaction_key = $1 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP RETURNING ...`. Exactly one request can receive a row and continue. Zero rows means fail closed: no token exchange for a missing, expired, processing, consumed, or concurrently claimed transaction. Expired pending rows may be marked `expired` separately without authorizing the callback.
4. If Meta reports denial, atomically finish the record as `consumed_denied`, record only a normalized reason category, and redirect with a safe cancellation status. Never include Meta's raw description.
5. Exchange the authorization code from the server with the app ID, app secret, and exact callback URI. Put credentials in the provider-required HTTPS request body/header, not application logs or GrowthWise URLs. Apply a short timeout, response-size limits, expected content type/schema checks, and generic error mapping.
6. Where Instagram supports it, exchange the initial short-lived token for a long-lived user token server-side. Verify identity using the resulting token in an `Authorization` header and the minimum identity fields. Require one professional Instagram identity with non-empty stable account ID and username. Never accept an account identifier from the browser or client JSON as the new binding.
7. In one database transaction, derive the account-binding key, enforce its unique ownership, and insert or update the owning tenant's encrypted credential. If another tenant owns the key, the unique-constraint conflict fails closed and the transaction rolls back; no partial credential or ownership state remains. Reconnection by the existing owner follows the explicitly tested update path.
8. Mark the transaction `consumed_success` only after the binding/credential database transaction commits, or `consumed_failed` after a terminal denial/exchange/identity/storage failure. Store no authorization code. Retain only minimal expiry/audit metadata and delete terminal transactions after a short operational retention window.
9. Redirect with `303` to a fixed, server-selected GrowthWise settings path, for example `/settings/integrations?instagram=connected` or `?instagram=cancelled|attention`. The query carries only a small allowlisted status. It never contains `business_id`, state, code, provider error text, account ID, username, or token. The page then calls the authenticated health endpoint for authoritative display.

No `return_to` URL is accepted. This prevents open redirects. Exceptions are caught at the outer boundary, assigned a random correlation ID, and surfaced as a generic safe failure; secret-bearing provider bodies are not logged.

## State, CSRF, expiry, and replay semantics

The transaction record is authoritative. HMAC validation alone never authorizes a callback. Its tenant is immutable, and callback code has no path that accepts a callback `business_id`.

| Condition | Required behavior |
|---|---|
| State missing, duplicated, malformed, bad HMAC, or no record | Do not call Meta or write a credential. Show the fixed safe failure destination. |
| State expired (server clock is at/after `expires_at`) | Atomically mark expired when possible; do not exchange the code; direct the user to start again. |
| State replayed / callback invoked twice | The atomic guarded SQL update returns a row to exactly one caller. Every later call gets zero rows and performs no provider call or credential write. It returns the same generic invalid/expired-flow outcome, not the prior result. |
| `business_id` changed in the browser | Start validates it before creation. Callback ignores all caller tenant input and uses the immutable transaction tenant. If any duplicated tenant field or stored record/key mismatch exists, fail closed and quarantine the record. |
| Concurrent callbacks | The database's atomic guarded update, not in-memory flags, provides the one winner across function instances. |
| Database transaction unavailable or ambiguous | Do not release OAuth. Never fall back to Blobs or best-effort read/write for replay prevention or ownership uniqueness. |

Transactions expire after ten minutes. A scheduled or opportunistic cleanup may remove terminal/expired records after 24 hours; cleanup is not part of authorization correctness.

## Encrypted multi-tenant storage

Use `@netlify/database` through `_instagram-store.mjs`, with each migration in Netlify's required `netlify/database/migrations/<number>_<lowercase-slug>/migration.sql` layout. Every query is parameterized. Every multi-statement operation checks out one client from `db.pool`, performs `BEGIN` / `COMMIT` or `ROLLBACK` on that same client, and releases it in `finally`. Tests inject a database adapter; no unit test requires production Netlify access.

The minimum schema is:

* `instagram_oauth_transactions`: `transaction_key` primary key; immutable non-null `business_id` and `return_destination_id`; constrained non-null `status`; non-null `expires_at`; `created_at`, `updated_at`, and optional `processing_started_at` / `consumed_at`. The derived transaction key is sufficient; raw browser state is forbidden.
* `instagram_credentials`: `business_id` primary key; `account_binding_key` unique and non-null; encrypted credential payload; encryption key version; constrained credential status; token-expiration metadata; safe username/display metadata; `created_at`, `updated_at`, and `last_verified_at`.

The encrypted plaintext is a small versioned JSON object containing sensitive provider identity/token material required by the implementation, including the verified stable account ID, access token, token type/scope, and lifecycle facts. Access tokens are never plaintext columns. A fresh 96-bit IV is mandatory for every AES-256-GCM encryption, including reconnects and refreshes. AAD is the canonical, versioned context `growthwise-instagram-database\ncredential-v1\n<business_id>\ninstagram\n<account_binding_key>`; moving ciphertext to another tenant/account fails authentication. Decryption/tag/schema failure returns **Needs Attention**, emits only a redacted event, and never falls back silently.

### Unique account binding

`account_binding_key` is `HMAC-SHA-256(GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET, canonical-account-id)`, with a versioned encoding suitable for rotation. OAuth state and encryption secrets are forbidden inputs. Its database `UNIQUE` constraint is authoritative: application-level check-then-write is not.

Connection/reconnection checks ownership and writes the credential inside one SQL transaction. A conflicting key owned by another `business_id` is a terminal safe failure and cannot steal or silently rebind the account. The existing owner may reconnect only through an explicitly tested update that preserves `business_id` and the same binding key. Any failed binding or credential statement rolls back the entire operation, so neither a valid orphan credential nor a valid orphan ownership row can remain. This separation lets OAuth-state secrets rotate without changing durable account-binding keys.

## Token lifecycle

1. **Exchange:** Consume the authorization code once on the server and validate the provider response. The short-lived token exists only in function memory long enough to verify/exchange/encrypt it.
2. **Long-lived credential:** When supported by the active Instagram Login product, immediately obtain the provider's long-lived form. Persist only encrypted token material and provider-derived expiration metadata. If long-lived exchange is unsupported, store the short-lived credential encrypted and surface its shorter reconnect horizon; do not fabricate an expiry.
3. **Verification:** On connection-status checks, select by the authenticated tenant, decrypt with tenant/account-binding AAD, check local expiry with a small safety window, then query identity. Update username/display name and `last_verified_at` only after stable account identity still matches.
4. **Refresh:** A server-only lifecycle job may refresh within the provider-supported refresh window (proposed threshold: 14 days before expiration). Encrypt refreshed material with a fresh IV, update transactionally, verify identity again, and preserve the prior credential unless the transaction commits. Exact refresh timing is confirmed during later provider acceptance.
5. **Reconnect:** Expired, revoked, scope-deficient, undecryptable, or identity-mismatched credentials become `needs_attention` with a normalized internal reason. The UI offers **Reconnect**, which starts a new transaction. Successful reconnect for the same tenant/account atomically replaces the credential; selecting a different account is rejected unless an explicit, separately authorized disconnect/rebind operation exists.
6. **Revocation:** Provider invalid-token/revocation responses never trigger retries with secrets in logs. Mark **Needs Attention**, stop scheduled use, and request reconnection. A future Disconnect action must attempt provider revocation when supported, transactionally erase token ciphertext/release account ownership, and retain a token-free audit record.
7. **Operational failures:** Timeout/rate-limit/provider outage does not prove revocation. Keep the credential but report **Needs Attention** (or a safe retry action) for this three-state UI; never label it Connected without a successful current verification under the endpoint's freshness policy.

An access token may never appear in a GrowthWise URL, frontend JavaScript, local/session storage, client JSON, application log, Git content, thrown error, analytics event, or response. The same rule applies to authorization codes and app secrets. Provider request/response debug logging must use an allowlist, not recursive redaction after the fact.

## Connection health contract

Conceptually refactor `instagram-connection.mjs` to depend on a tenant-safe credential service:

1. Preserve `GET`, no-store responses, the temporary admin-key check, explicit tenant registry, and `business_id` equality validation.
2. Query `instagram_credentials` only by the authenticated `business_id`; verify row ownership and account-binding AAD before decrypting.
3. No primary record means **Not Connected** (unless an explicitly permitted legacy development fallback exists). Pending/partial, expired, revoked, corrupt, identity-mismatched, scope-invalid, or unverifiable credentials mean **Needs Attention**.
4. **Connected** requires non-expired usable credentials, a successful professional-account identity response, exactly one identity, and an exact match to the decrypted identity and stored account-binding key. Refresh safe username/display identity and `last_verified_at` after success.
5. Return only `{ business_id, state, checked_at, account?: { username, name }, action? }`. Never return stable account IDs, token metadata, credential source, provider response, provider error, or raw exception. All actions/messages come from a fixed allowlist.

Identity ambiguity or any disagreement is always **Needs Attention** and never silently updates the binding.

## Reusable settings experience

Create one tenant-parameterized GrowthWise Instagram settings component, not client-specific branches:

* **Not Connected:** explanation plus **Connect Instagram**.
* **Connecting:** issue the authenticated same-origin start request once, validate the returned authorization URL, disable repeat clicks before browser navigation, and show accessibility-friendly progress text.
* **Connected:** `Connected to @username`, last checked time if useful, and no account ID. Offer a health refresh. Reserve a future **Disconnect** control behind an explicit confirmation and server capability flag.
* **Needs Attention:** safe nontechnical action text plus **Reconnect**. Never echo provider errors.
* **Return from OAuth:** treat `?instagram=connected|cancelled|attention` only as a hint, remove it with `history.replaceState`, then fetch authoritative state. Do not infer connection from the query.

The component receives the active server-authorized `business_id`/client config and uses the same endpoints for `growthwise-dev`, `dexters-hats`, and future businesses. Display names and tenant IDs come from configuration. `growth.wise1` is test verification data only, never an allowed-account constant. The first manual acceptance test uses the GrowthWise Social app with the already professional/tester-authorized `growth.wise1` account.

## Migration and compatibility

1. Add encrypted store reads and OAuth writes without deleting `token_env` / `account_id_env` fields. Stored OAuth credentials always win.
2. Permit legacy lookup only when an explicit server deployment flag identifies a non-production development environment and the client currently has both references. Never fall back after a stored record is corrupt, mismatched, pending, revoked, or expired; that could resurrect an old account.
3. Preserve current test dependency injection so existing shadow-mode/connection tests do not require a real database or Meta network.
4. Connect `growthwise-dev` through OAuth and compare safe health output. Then connect/reconnect Dexter through the identical path when approved. Do not migrate tokens by copying plaintext through the browser; either reauthorize or use a one-time restricted server migration tool that encrypts immediately and is removed afterward.
5. After all allowed development tenants have OAuth records and a documented rollback window passes, remove the fallback flag, legacy read code, client `token_env`/`account_id_env` properties, and obsolete Netlify variables. Secret scanning and deployment review confirm removal.

Migration does not alter `facebook-post.mjs`, Dexter Square behavior, Publishing Core orchestration, channel permission policy, or `live_sent: false` assertions.

## Threat review and controls

| Threat | Control / fail-closed result |
|---|---|
| CSRF / login CSRF | Authenticate start, require same origin, random server-backed state, HMAC it, and bind immutable tenant/expiry. Callback without a valid pending record does nothing. |
| OAuth code interception | Exact HTTPS callback, code used only server-side, ten-minute state, one consumer, no code in final URL, and no-referrer/no-store. A stolen code without transaction state cannot bind. PKCE is not improvised without a concrete provider contract. |
| Replay / duplicate callback | Atomic pending-to-processing compare-and-set. All later callbacks perform zero exchange/write work. |
| Cross-tenant access | Explicit client allowlist, parameterized tenant predicates, transaction-derived tenant, primary/unique constraints, and AES-GCM tenant/account AAD on every read/write. |
| State-secret rotation affecting durable bindings | State HMAC and account-binding HMAC use independent secrets. Rotating `GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET` may invalidate pending flows but cannot change existing `account_binding_key` values; the binding secret follows its own controlled migration. |
| Token/app-secret leakage | Server environment and encrypted storage only; authorization headers/request bodies; allowlisted telemetry; generic errors; response tests and repository secret scans. |
| Logs and observability | Log correlation ID, normalized event, tenant-safe identifier if policy permits, and status only. Never log URLs containing OAuth callback queries, request bodies/headers, provider bodies, ciphertext, code, state nonce, token, or secret. Configure platform access-log query redaction where available. |
| Browser storage | Only the existing temporary admin key remains in tab session storage until auth redesign. Codes/tokens/app secrets/account IDs never enter JavaScript or Web Storage. OAuth result query is a safe enum and promptly removed. |
| Open redirect / host spoofing | Fixed configured origin and paths; no caller `return_to`; do not trust Host/forwarded headers. |
| Credential theft/tampering | AES-256-GCM, random IV per write, versioned server-only key, AAD tenant/record binding, minimal decrypt scope, and authenticated-decryption failure to Needs Attention. Key rotation is versioned and re-encrypts after successful decrypt. |
| Compromised/expired credentials | Local expiry checks, verified refresh, identity pinning, revocation mapping, no mutation use, Needs Attention plus reconnect. |
| Duplicate account across tenants | A dedicated-secret account-binding key has a database `UNIQUE` constraint. A connection transaction rejects a conflicting owner and rolls back completely; no tenant can steal or silently rebind it. |
| Malicious provider response | Time/size/schema limits, exact identity cardinality/type checks, stable-ID pinning, generic mapping, and no raw reflection. |
| Excessive attempts | Rate-limit starts by coarse client signal and tenant, callbacks by transaction; limits must not require logging secrets. Generic errors avoid tenant/state enumeration. |

Ambiguous storage state, identity, tenant ownership, expiry, cryptography, or provider response never produces **Connected**.

## TDD and verification matrix

Tests must inject clock, RNG, environment, store, crypto wrapper where useful, and fetch; no test calls Meta or requires deployed Netlify state.

### OAuth endpoint tests

* Start requires the existing authentication boundary; empty server key and wrong key both fail without a transaction.
* Unknown/malformed business is rejected, and client/config tenant mismatch is rejected.
* Start accepts the existing key only in `X-GrowthWise-Key`, creates a tenant-bound ten-minute transaction, and returns exactly one safe authorization URL containing the exact callback, minimum scope, and opaque state—not the admin key, app secret, token, tenant claims, or arbitrary return target.
* Cross-origin start requests, permissive CORS, unsafe authorization origins, extra response fields, and frontend-added authorization parameters are rejected/tested.
* Valid state is accepted exactly once; two concurrent callbacks produce one exchange and one credential write.
* Missing, duplicate, malformed, bad-MAC, expired, replayed, and already-processing state are rejected before Meta calls.
* Added/changed callback `business_id` is ignored/rejected and cannot alter transaction ownership.
* Meta authorization denial maps to a safe cancellation status with no raw description.
* Token-exchange/long-lived-exchange/network/schema failures map safely and consume the transaction according to retry policy.
* Wrong, empty, non-professional, or multi-account identity fails closed and stores no active credential.
* Fixed redirects prevent arbitrary `return_to` and spoofed-host redirects.

### Storage and leakage tests

* AES-256-GCM credential round trip recovers the original token only for the matching tenant/AAD; wrong key, modified tag/ciphertext, reused/mismatched record metadata, and cross-tenant read fail.
* Persisted database fields contain no plaintext synthetic token. Fresh writes use different IV/ciphertext.
* A credential cannot be read through another tenant ID, including crafted key segments.
* The same Instagram account cannot bind to two tenants; concurrent transactional attempts yield one owner through the unique constraint.
* Account-binding derivation uses `GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET`, never the OAuth state secret; rotating the state secret leaves the same account binding key and duplicate-account protection intact.
* Binding-secret rotation tests cover a versioned migration, collision detection across old/new keyed values, and fail-closed behavior on ownership disagreement; the old binding secret is not retired until every active row is migrated and verified.
* A failed binding or credential statement rolls back, leaves no valid partial connection, and never produces Connected.
* Token, authorization code, app secret, state nonce, provider raw errors, and account ID never appear in response bodies/headers/redirects, safe errors, captured logger calls, frontend assets, fixtures, or snapshots. Use sentinel secrets for assertions.

### Health, migration, and regression tests

* No stored credential and no permitted fallback returns **Not Connected**.
* Valid encrypted credential row and matching identity returns **Connected** with only `@username`/safe display identity.
* Expired, revoked, invalid, scope-deficient, corrupt, partial, or mismatched credential returns **Needs Attention** and no identity.
* Stored OAuth credential is primary; legacy fallback is development-only, remains usable for existing shadow tests, and is never used after a bad stored record.
* Reconnect updates only the same tenant/account unless an approved rebind exists.
* Existing Dexter Square/Facebook tests and behavior are unaffected.
* All Publishing Core unit/integration tests continue to assert `live_sent === false`; add a repository-level guard covering every Instagram channel result/configuration.
* Static checks verify neither `instagram_business_content_publish` nor a publishing/media-container API call is introduced in runtime code for this milestone.

Before merge, run the focused OAuth/store/health suite, full `npm run test:publishing`, `git diff --check`, secret scanning, response/log leakage tests, and a diff assertion that protected Dexter/Facebook and Auto City paths did not change. Manual testing uses a non-production Meta app/tester context and stops after identity health.

### Dependency reproducibility gate

Implement the subsystem with current documented `@netlify/database` APIs and repository-supported migrations under `netlify/database/migrations/<number>_<lowercase-slug>/migration.sql`. Do not initialize or mutate production during this task. Unit tests inject the adapter and deterministically exercise SQL/storage behavior. Real acceptance runs only against an already-migrated isolated Deploy Preview database branch: it verifies schema and behavior, creates uniquely prefixed synthetic rows, deletes only those rows, and never applies DDL or drops application objects. If that context is unavailable, report the integration suite as **NOT TESTABLE** rather than weakening the design or falling back to Blobs; real transaction/constraint verification remains required before merge/deployment.

## Operations and observability

Audit events are token-free: start accepted/rejected category, callback consumed category, binding outcome, health transition, refresh outcome, and actor/session identifier once real user authentication exists. Use UTC timestamps and correlation IDs. Alert on repeated state failures, cross-tenant/reverse-binding conflicts, decrypt failures, and refresh failures without including provider payloads.

Each secret has an independent rotation lifecycle:

* OAuth state-secret rotation may accept an explicitly versioned previous state key only for transactions issued before the rotation and still inside the ten-minute TTL. New transactions use the current key; the previous key is removed after that bounded window. It never derives account indexes.
* Account-binding-secret rotation is a controlled durable-data migration, not a state-key side effect. Use versioned binding-key IDs and a transactional migration of active credential rows. During migration, check both versions and fail closed on disagreement or duplicate ownership. Retire the old binding secret only after complete reconciliation and regression verification. Losing it before migration blocks binding verification and produces **Needs Attention**; code must not silently rebuild ownership from caller input.
* Credential-encryption key rotation uses `key_version`: deployment temporarily exposes current and explicitly named previous server keys, reads old ciphertext, re-encrypts with a fresh IV/current key after successful verification, then retires the old key after coverage is confirmed. Losing all applicable keys means **Needs Attention** and reconnect; it never means plaintext recovery.

## Explicitly out of scope

* Live Instagram posting or enabling publishing
* Instagram media containers or durable publishing media design
* `instagram_business_content_publish` or any content-publishing permission
* Webhooks
* Messaging or comment automation
* Billing
* A major user-auth redesign (the temporary admin boundary is acknowledged, not blessed as final)
* Facebook integration replacement or changes to Dexter's legacy Square/Facebook flow
* Auto City changes
* Deployment, merge to `main`, or external Meta configuration/actions
* An implementation plan (to follow only after this architecture is approved)

## Approved preflight decisions and remaining acceptance gate

1. **Canonical deployment origin:** Paul confirmed `https://euphonious-beijinho-db4b4d.netlify.app` and its exact callback path. This task does not deploy.
2. **Database architecture:** Paul approved Netlify Database/PostgreSQL. Deterministic adapter tests are mandatory; real isolated database integration is required before merge/deployment and is reported **NOT TESTABLE** when the Codex environment lacks that context.
3. **Provider contract:** direct `developers.facebook.com` verification was blocked by the Codex proxy. Paul approved current first-party Meta Postman documentation and explicitly supplied the authorization, exchange, long-lived/refresh, and identity endpoints. The implementation requests only `instagram_business_basic`, does not assume PKCE, and stops if later live acceptance proves a materially different requirement.

## Expected implementation touch set (later, not in this change)

The anticipated exact repository files are:

* `netlify/functions/instagram-oauth-start.mjs` (new)
* `netlify/functions/instagram-oauth-callback.mjs` (new)
* `netlify/functions/_instagram-oauth.mjs` (new shared state/exchange helpers)
* `netlify/functions/_instagram-store.mjs` (new parameterized PostgreSQL transaction/credential adapter)
* `netlify/database/migrations/<number>_<lowercase-slug>/migration.sql` (new schema and constraints)
* `netlify/functions/_instagram-crypto.mjs` (new encryption/state primitives)
* `netlify/functions/instagram-connection.mjs`
* `clients/growthwise-dev.json`
* `clients/dexters-hats.json`
* `index.html` (shared settings UI in the current application structure)
* `tests/publishing/instagram-oauth.test.mjs` (new)
* `tests/publishing/instagram-store.test.mjs` (new)
* `tests/publishing/instagram-connection.test.mjs`
* `tests/publishing/publishing-shadow-endpoint.test.mjs` and/or the existing shadow regression tests for the global `live_sent: false` guard
* `package.json` / lockfile (`@netlify/database` dependency)
* a generated package-manager lockfile, if dependency installation creates one, committed with the same exact resolved version
* `docs/INSTAGRAM_CONNECTION_RUNBOOK.md`

No Publishing Core channel/orchestrator, `facebook-post.mjs`, Square function, Auto City page, webhook, or deployment configuration file should need runtime behavior changes for this identity-only milestone. Environment values and Meta console settings are deployment operations, not repository content.

## Design self-review

* **Placeholders:** the origin and provider endpoint contract are approved above. The only environment-dependent acceptance item is the real isolated database integration; it may be **NOT TESTABLE** in Codex but remains required before merge/deployment.
* **Contradictions:** the flow is self-service but still temporarily admin-key-gated; this is called out as a migration boundary. The UI may say Connected only after authoritative health verification, not merely callback success.
* **Tenant isolation:** tenant comes from an allowlisted start and immutable server transaction; SQL predicates/constraints and AAD independently enforce it. Callback input cannot select a tenant.
* **Secret leakage:** the temporary admin key travels only in the established same-origin request header. The start response contains only a server-built safe authorization URL; responses, redirects, logs, browser storage, client config, and Git are explicitly denied token/code/app-secret content and covered by tests.
* **Cryptographic separation:** OAuth state, durable account-index derivation, and credential encryption use three independent secrets and independent rotation procedures. State-secret rotation cannot rename or bypass existing account bindings.
* **Publishing boundary:** only `instagram_business_basic` is requested. No publishing permission, container, endpoint, media storage, or live action is designed. Publishing Core remains `live_sent: false`.
* **Dependency reproducibility:** use the documented `@netlify/database` API and the repository lockfile; never invent methods. Full regressions follow the dependency change.
* **Infrastructure restraint:** this reuses Netlify Functions, Node crypto, the existing client registry, and Netlify's PostgreSQL-backed Database. Existing Publishing Core Blobs remain unchanged.
* **Fail closed:** replay, ownership conflicts, partial writes, invalid identity, expired/compromised credentials, provider ambiguity, and cryptographic/storage errors never bind or report Connected.
