# GrowthWise Instagram OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GrowthWise business owner click **Connect Instagram**, authorize one professional Instagram account, return safely, and see authoritative tenant-scoped connection health without Paul creating or pasting tokens.

**Architecture:** Add two small Netlify endpoints over shared OAuth, cryptography, provider, and a Netlify Database/PostgreSQL adapter. OAuth transactions are short-lived and claimed once by an atomic guarded SQL update; credentials are AES-256-GCM encrypted; a database unique constraint enforces durable account ownership using a binding secret independent from OAuth state signing. The encrypted database is primary and the current environment-reference path remains an explicitly gated development fallback. A parameterized browser component starts OAuth and renders health. No unit in this plan publishes, creates media containers, or registers webhooks.

**Tech Stack:** Node.js ES modules, built-in `node:test` / `node:assert/strict` / `node:crypto`, Netlify Functions, `@netlify/database`, PostgreSQL migrations under `netlify/database/migrations/`, JSON client configuration, and the existing HTML/CSS/JavaScript application. Existing Publishing Core may continue using Netlify Blobs.

**Approved spec:** `docs/superpowers/specs/2026-09-17-growthwise-instagram-oauth-design.md`

**Execution branch:** Create a feature branch from `platform-v1` containing approved merge `9a8d71dcec5e508d875ed21fd2aeb2e0842bc3ba` and this plan/spec history. Never work on or merge into `main`. The final draft PR targets `platform-v1`.

---

## Non-negotiable safety rules

- Do not deploy during execution and do not perform any external Meta configuration or mutation.
- Do not add live Instagram posting, media-container creation, `instagram_business_content_publish`, webhooks, messaging, or comment automation.
- Do not change Auto City behavior. Treat `automotive-pilot.html`, `netlify/functions/facebook-post.mjs`, and `netlify/functions/add-product.mjs` as protected files.
- Preserve Dexter Square/Facebook behavior. Any `index.html` change is limited to the reusable Instagram connection panel/bootstrap.
- Publishing Core stays shadow-only. Every Publishing Core result remains `live_sent === false`.
- Tokens, authorization codes, app secrets, encryption keys, OAuth state secrets, and account-binding secrets never appear in frontend JavaScript, GrowthWise return URLs, logs, fixtures, snapshots, Git, or client JSON. Test sentinel values are synthetic and must not resemble real credentials.
- Fail closed for tenant, identity, cryptographic, storage, replay, provider, or account-ownership ambiguity.
- Every task follows red/green/refactor: write the named failing test, observe the expected failure, implement only the behavior under test, observe the pass, run the stated regression, review the diff, then commit.
- Stop on every gate labeled **STOP / DECISION NEEDED**. Do not substitute weaker security behavior.

## Planned file map and stable interfaces

### Runtime modules

- `netlify/functions/_instagram-crypto.mjs`
  - `createInstagramCrypto({ stateSecrets, bindingSecrets, credentialKeys, randomBytesImpl? })`
  - returned methods: `createState()`, `verifyState(state)`, `transactionKey(state)`, `accountBindingKey(accountId)`, `accountBindingKeys(accountId)`, `encryptCredential({ businessId, accountId, payload })`, `decryptCredential({ businessId, accountId, encryptedToken })`
- `netlify/functions/_instagram-store.mjs`
  - `instagramDatabase()` uses `getDatabase()` from `@netlify/database`
  - transaction methods: `createTransaction(record)`, `claimTransaction({ transactionKey })`, `finishTransaction({ transactionKey, status, now })`
  - credential methods: `readCredential(businessId)`, `connectCredential(input)`, `updateCredentialHealth(input)`
  - `connectCredential` uses one checked-out `db.pool` client for `BEGIN` / `COMMIT` / `ROLLBACK`, always released in `finally`
  - all SQL is parameterized and all exported persistence helpers accept `{ database }` injection for tests
- `netlify/functions/_instagram-oauth.mjs`
  - constants verified in preflight: `INSTAGRAM_AUTHORIZATION_ENDPOINT`, `INSTAGRAM_TOKEN_ENDPOINT`, optional verified long-lived/refresh endpoints, `INSTAGRAM_IDENTITY_ENDPOINT`, `INSTAGRAM_IDENTITY_FIELDS`, `INSTAGRAM_IDENTITY_SCOPE`
  - `configuredInstagramOAuth()`, `callbackUri(publicOrigin)`, `buildAuthorizationUrl(input)`, `exchangeAuthorizationCode(input)`, `exchangeLongLivedToken(input)` when supported, `verifyProfessionalIdentity(input)`, and normalized `InstagramProviderError`
- `netlify/functions/_instagram-clients.mjs`
  - `INSTAGRAM_CLIENTS` and `getInstagramClient(businessId)` centralize the explicit `growthwise-dev` / `dexters-hats` registry and validate `config.business_id`
  - each registry entry includes an immutable `returnDestinationId`: `growthwise-dev-integration` for `growthwise-dev`, `dexter-integration` for `dexters-hats`
  - `INSTAGRAM_RETURN_DESTINATIONS` maps only those IDs to `/instagram-dev.html` and `/`; `resolveInstagramReturnDestination({ destinationId, hint, publicOrigin })` accepts only the three safe hints and constructs a URL from the configured origin plus the fixed mapped path
- `netlify/functions/instagram-oauth-start.mjs`
  - `createInstagramOAuthStartHandler(dependencies?)`; default export handler
- `netlify/functions/instagram-oauth-callback.mjs`
  - `createInstagramOAuthCallbackHandler(dependencies?)`; default export handler
- `netlify/functions/instagram-connection.mjs`
  - preserve `createInstagramConnectionHandler(dependencies?)`; add store/crypto/binding dependencies without breaking current deterministic tests
- `assets/instagram-connection.mjs`
  - `createInstagramConnectionController({ businessId, endpointBase, authorizationOrigin, adminKey, fetchImpl, navigate, historyImpl })`
  - `mountInstagramConnection({ root, businessId, endpointBase, authorizationOrigin, getAdminKey, fetchImpl?, navigate?, historyImpl? })`
- `instagram-dev.html`
  - temporary GrowthWise beta acceptance harness that mounts the same component with `businessId: "growthwise-dev"`; contains no provider/account credentials and no `growth.wise1` account allowlist

### Test files

- `tests/publishing/instagram-crypto.test.mjs`
- `tests/publishing/instagram-store.test.mjs`
- `tests/publishing/instagram-oauth-provider.test.mjs`
- `tests/publishing/instagram-oauth.test.mjs`
- `tests/publishing/instagram-connection.test.mjs`
- `tests/publishing/instagram-connection-ui.test.mjs`
- `tests/publishing/instagram-safety-regression.test.mjs`
- `tests/integration/instagram-database.test.mjs` (runs only with an explicitly configured isolated non-production database)

The added `_instagram-clients.mjs`, provider-focused test, UI module/test, optional real-database integration test, and safety test separate client lookup, provider behavior, DOM-independent browser logic, database acceptance, and repository-wide negative assertions. This is smaller and easier to audit than putting those concerns in endpoint files.

### Record/status vocabulary

- OAuth transaction statuses: `pending`, `processing`, `consumed_success`, `consumed_failed`, `consumed_denied`, `expired`.
- Credential statuses: `pending`, `connected`, `needs_attention`.
- Public connection states: `Not Connected`, `Connected`, `Needs Attention`.
- Safe callback hints: `connected`, `cancelled`, `attention` only.
- Server-selected return destination IDs: `growthwise-dev-integration`, `dexter-integration` only. Browsers/provider callbacks cannot supply either ID.
- Transaction TTL: exactly 10 minutes, with expiry defined as `now >= expires_at`.

---

### Task 1: Mandatory preflight gate and approved database amendment

**This task must complete before Tasks 2–11. Do not initialize or mutate a production database.**

**Files:**
- Modify: `docs/superpowers/specs/2026-09-17-growthwise-instagram-oauth-design.md`
- Modify: `docs/superpowers/plans/2026-09-17-growthwise-instagram-oauth.md`
- Create: `docs/verification/instagram-oauth-preflight.md`

**Approved amendment:** Paul replaced the proposed security-critical Netlify Blobs store with Netlify Database/PostgreSQL because Blobs' last-write-wins behavior has no concurrency-control guarantee sufficient for one-use OAuth consumption or unique cross-tenant account ownership. Remove all `onlyIfNew`, `onlyIfMatch`, ETag-locking, Blob replay, Blob reservation/finalization, and real-Blob preflight requirements. Preserve existing Publishing Core Blobs unchanged.

- [ ] **Step 1: confirm the existing feature branch and protected baseline**

Confirm the current branch is `feat/growthwise-instagram-oauth`, HEAD descends from the requested starting merge, and the three protected files are unchanged. Do not restart from another branch and do not change `main`.

- [ ] **Step 2: record the confirmed canonical origin**

Record Paul's authoritative production-domain confirmation and exact values:

```text
GROWTHWISE_PUBLIC_ORIGIN=https://euphonious-beijinho-db4b4d.netlify.app
https://euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/instagram-oauth-callback
```

This is configuration evidence only; do not deploy.

- [ ] **Step 3: record the approved provider preflight basis**

Record that direct `developers.facebook.com` access was blocked by the Codex environment proxy. Paul approved current first-party Meta Postman documentation and this contract: authorization `https://www.instagram.com/oauth/authorize`; code exchange `POST https://api.instagram.com/oauth/access_token`; API host `https://graph.instagram.com`; long-lived exchange `/access_token` with `ig_exchange_token`; refresh `/refresh_access_token` with `ig_refresh_token`; identity `/me` using only minimum ID/username fields; exactly `instagram_business_basic`. Do not add PKCE by assumption, publishing scope, publishing endpoints, webhooks, messaging, or comment automation.

- [ ] **Step 4: amend and independently review the spec and plan**

Ensure both documents consistently require `@netlify/database`, parameterized SQL, migrations under `netlify/database/migrations/`, atomic guarded claim, unique account binding, and one-client transactions with release in `finally`. If no isolated database exists, real integration is **NOT TESTABLE**, not a reason to weaken/fallback. Review for every stale Blob OAuth requirement.

- [ ] **Step 5: commit the approved documentation correction**

```bash
git add docs/superpowers/specs/2026-09-17-growthwise-instagram-oauth-design.md docs/superpowers/plans/2026-09-17-growthwise-instagram-oauth.md docs/verification/instagram-oauth-preflight.md
git diff --cached --check
git commit -m "docs: move Instagram OAuth state to PostgreSQL"
```

---

### Task 2: Cryptographic primitives (TDD)

**Files:**
- Create: `netlify/functions/_instagram-crypto.mjs`
- Create: `tests/publishing/instagram-crypto.test.mjs`

**Interfaces:** Implement the `createInstagramCrypto` factory from the file map. Configuration maps are versioned (`{ current: { id, key }, previous?: [...] }`). `createState()` returns `{ state, nonceHash, keyVersion }`; browser state contains only `v1.<nonce>.<tag>`. `accountBindingKey(s)` returns versioned database binding values. The encrypted token envelope is `{ algorithm: "A256GCM", key_version, iv, ciphertext }` with the authentication tag included in `ciphertext`. AAD is the canonical UTF-8 string `growthwise-instagram-database\ncredential-v1\n<business_id>\ninstagram\n<account_binding_key>`.

- [ ] **Step 1: write RED tests with these exact names**

```text
createState uses a fresh 256-bit nonce and exposes no business claim
verifyState rejects malformed state and a bad HMAC in constant-time comparison path
account binding HMAC uses only the dedicated binding secret
OAuth state-secret rotation does not change the account-binding key
credential encryption round trip requires matching tenant and account AAD
credential encryption uses a fresh 96-bit IV for every write
modified ciphertext or authentication tag fails closed
unknown credential key version fails closed without key material in the error
```

Use deterministic injected RNG only where exact vectors are asserted; use real randomness for the fresh-IV inequality test. Use recognizable synthetic sentinels and assert none appear in serialized envelopes/errors.

Run:

```bash
node --test tests/publishing/instagram-crypto.test.mjs
```

Expected RED: module-not-found failure.

- [ ] **Step 2: implement minimal crypto**

Use `node:crypto` `randomBytes(32)`, HMAC-SHA-256, `timingSafeEqual` after strict format/length validation, SHA-256 nonce-key derivation, and AES-256-GCM with a new 12-byte IV. Reject unsafe key segments, wrong decoded key lengths, unknown versions, malformed base64url, and authentication failures with fixed internal error codes/messages containing no inputs. State signing uses only `GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET`; reverse binding uses only `GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET`; credential encryption uses only `GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY`.

- [ ] **Step 3: verify GREEN and leakage invariants**

```bash
node --test tests/publishing/instagram-crypto.test.mjs
git diff --check
git diff -- netlify/functions/_instagram-crypto.mjs tests/publishing/instagram-crypto.test.mjs
```

Expected: 8 tests PASS. Confirm no environment values/default secrets are embedded.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/_instagram-crypto.mjs tests/publishing/instagram-crypto.test.mjs
git commit -m "feat: add separated Instagram cryptography"
```

---

### Task 3: PostgreSQL schema and one-use OAuth transactions (TDD)

**Files:**
- Create: `netlify/database/migrations/*_instagram_oauth.sql`
- Create: `netlify/functions/_instagram-store.mjs`
- Create: `tests/publishing/instagram-store.test.mjs`
- Modify: `package.json` and repository lockfile

**Interfaces:** Use `getDatabase` from `@netlify/database`. Add `instagram_oauth_transactions` with `transaction_key` primary key; immutable non-null `business_id` and `return_destination_id`; constrained status; `expires_at`; timestamps and processing/consumed timestamps. Never persist raw state. Claim with the parameterized guarded `UPDATE ... WHERE transaction_key = $1 AND status = 'pending' AND expires_at > CURRENT_TIMESTAMP RETURNING ...`; zero rows fails closed.

- [ ] **Step 1: write RED persistence tests**

```text
pending OAuth transaction can be claimed exactly once
expired transaction cannot be claimed
consumed transaction cannot be claimed
two simultaneous claim attempts produce exactly one logical winner
callback replay fails before provider work
tenant and return destination cannot be altered after transaction creation
```

Use an injected deterministic database adapter that models the SQL invariants; additionally assert query text uses placeholders and never contains fixture business IDs, state, codes, usernames, or tokens.

- [ ] **Step 2: add migration and minimal adapter**

Create constrained schema and parameterized queries. `createTransaction` retries only a derived-key primary-key collision with a newly generated state. The callback never accepts tenant/destination input. Error messages contain no row data.

- [ ] **Step 3: verify and commit**

```bash
node --test tests/publishing/instagram-store.test.mjs --test-name-pattern="transaction|claim|replay|tenant"
git diff --check
git add package.json package-lock.json netlify/database/migrations netlify/functions/_instagram-store.mjs tests/publishing/instagram-store.test.mjs
git commit -m "feat: add one-use Instagram OAuth transactions"
```

---

### Task 4: Transactional encrypted credentials and unique account ownership (TDD)

**Files:**
- Modify: `netlify/database/migrations/*_instagram_oauth.sql`
- Modify: `netlify/functions/_instagram-store.mjs`
- Modify: `tests/publishing/instagram-store.test.mjs`
- Create when a safe context exists: `tests/integration/instagram-database.test.mjs`

**Interfaces:** `instagram_credentials` has `business_id` primary key, `account_binding_key UNIQUE NOT NULL`, encrypted credential payload, encryption-key version, status, expiration and safe identity metadata, and timestamps. `connectCredential` checks ownership and writes/reconnects on one checked-out `db.pool` client. It executes `BEGIN`, all parameterized ownership/credential statements, then `COMMIT`; on every failure it `ROLLBACK`s, and releases the client in `finally`. A conflict owned by another tenant fails closed.

- [ ] **Step 1: add RED storage tests**

```text
account_binding_key is unique across tenants
same Instagram account cannot bind to tenant B when tenant A owns it
credential creation and account ownership occur transactionally
failed credential write does not leave a valid connection
failed binding does not leave a valid credential
reconnect by the owning tenant preserves ownership and replaces ciphertext
cross-tenant credential reads fail closed
encrypted credential round trip succeeds
plaintext synthetic access token never appears in persisted record fields
modified ciphertext or authentication tag cannot decrypt
wrong tenant or account AAD cannot decrypt
state-secret rotation does not affect account-binding keys
transaction always releases its checked-out client
```

- [ ] **Step 2: implement minimal transactional binding**

Do not store plaintext provider identity/token material. Derive the unique binding key only with the dedicated binding secret. Do not use application check-then-write for uniqueness. A successful reconnect is allowed only for the existing `business_id` and binding; selecting another account is rejected until a separately authorized disconnect/rebind exists. Never log rows or query parameters.

- [ ] **Step 3: verify deterministic and optional real-database behavior**

```bash
node --test tests/publishing/instagram-crypto.test.mjs tests/publishing/instagram-store.test.mjs
node --test tests/integration/instagram-database.test.mjs
git diff --check
```

The integration command is **PASS** only against an explicitly configured isolated non-production PostgreSQL/Netlify Database context. If unavailable, report **NOT TESTABLE** and retain it as a pre-merge/deployment acceptance requirement; do not use production and do not fall back to Blobs.

- [ ] **Step 4: commit**

```bash
git add netlify/database/migrations netlify/functions/_instagram-store.mjs tests/publishing/instagram-store.test.mjs tests/integration/instagram-database.test.mjs
git commit -m "feat: store encrypted tenant Instagram credentials"
```

---

### Task 5: Verified provider helper and client registry (TDD)

**Files:**
- Create: `netlify/functions/_instagram-oauth.mjs`
- Create: `netlify/functions/_instagram-clients.mjs`
- Create: `tests/publishing/instagram-oauth-provider.test.mjs`
- Modify only if the provider contract requires configuration flags, never secrets: `clients/growthwise-dev.json`, `clients/dexters-hats.json`

**Interfaces:** Use the approved literal endpoints/scope/fields from Task 1. `buildAuthorizationUrl` receives `{ appId, callbackUri, state }`; it has no PKCE, return-URL, or business-ID argument. Provider requests use injected `fetchImpl`, `AbortSignal.timeout`, explicit response-byte limits, exact JSON schema validation, and server-side secret placement required by the approved contract. `verifyProfessionalIdentity` returns only normalized internal `{ accountId, username, name }`. `InstagramProviderError` carries a safe enum (`denied`, `exchange_failed`, `invalid_identity`, `temporarily_unavailable`) and no raw body/request.

- [ ] **Step 1: write RED tests**

Exact names:

```text
client registry accepts configured GrowthWise and Dexter tenants only
authorization URL uses the exact callback minimum scope and opaque state
authorization URL has no business claim arbitrary return or publishing scope
client registry assigns fixed allowlisted return destinations to GrowthWise and Dexter
unknown return destination and unsafe hint fail closed
code exchange sends secrets server-side and enforces response size and schema
verified supported long-lived exchange normalizes token expiry
professional identity requires one stable account ID and username
empty ambiguous and wrong-shaped identity responses fail closed
provider timeout and raw errors become safe normalized errors
```

Assert the authorization URL omits PKCE; do not add it by assumption. Use the approved long-lived exchange and refresh contracts. If later acceptance shows a concrete provider conflict, stop and update the design intentionally.

Run:

```bash
node --test tests/publishing/instagram-oauth-provider.test.mjs
```

Expected RED: provider/client modules do not exist.

- [ ] **Step 2: implement the verified provider contract**

Build URLs from constants and `GROWTHWISE_PUBLIC_ORIGIN`, never `Host`/forwarded/request input. Reject non-HTTPS configured origins outside explicit local-test injection. Enforce exact allowed query keys. Read `GROWTHWISE_INSTAGRAM_APP_ID` and app secret server-side only. Do not log. Do not request `instagram_business_content_publish` or call publish/container endpoints.

- [ ] **Step 3: verify GREEN**

```bash
node --test tests/publishing/instagram-oauth-provider.test.mjs
git diff --check
git diff -- netlify/functions/_instagram-oauth.mjs netlify/functions/_instagram-clients.mjs clients/growthwise-dev.json clients/dexters-hats.json tests/publishing/instagram-oauth-provider.test.mjs
```

Expected: 10 tests PASS, including either the supported or explicitly unsupported long-lived case. No client JSON contains token/account ID values or secret material.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/_instagram-oauth.mjs netlify/functions/_instagram-clients.mjs tests/publishing/instagram-oauth-provider.test.mjs
git add clients/growthwise-dev.json clients/dexters-hats.json
git commit -m "feat: add verified Instagram OAuth provider contract"
```

Omit unchanged client files from the actual commit.

---

### Task 6: Authenticated OAuth start endpoint (TDD)

**Files:**
- Create: `netlify/functions/instagram-oauth-start.mjs`
- Create: `tests/publishing/instagram-oauth.test.mjs`

**Interface:** `POST /.netlify/functions/instagram-oauth-start`; JSON input has exactly `{ business_id }`; authentication is non-empty `GROWTHWISE_ADMIN_KEY` matched against `X-GrowthWise-Key`. Success is `200` JSON with exactly `{ authorization_url }`. Dependencies inject admin key, public origin, app ID, crypto, store, client lookup, URL builder, clock, and rate limiter. The handler copies `returnDestinationId` only from the validated registry entry into the transaction; the request schema has no destination, path, return URL, callback tenant, or redirect URI field.

- [ ] **Step 1: write RED start tests**

Exact names:

```text
OAuth start without configured server admin key fails before storage
OAuth start with wrong admin key fails before storage
OAuth start rejects unknown business and malformed business ID
OAuth start rejects cross-origin and non-canonical requests
OAuth start rejects non-POST wrong content type extra body fields and oversized body
valid start creates one ten-minute tenant-bound transaction
growthwise-dev transaction receives growthwise-dev-integration destination
dexters-hats transaction receives dexter-integration destination
valid start returns only one safe HTTPS Meta authorization URL
start response contains no sentinel admin key app secret token or business claim
start rate limit fails closed without creating another transaction
```

Use fake values `SENTINEL_ADMIN_KEY_DO_NOT_LEAK`, `SENTINEL_APP_SECRET_DO_NOT_LEAK`, and `SENTINEL_TOKEN_DO_NOT_LEAK`; capture response status/body/headers and logger calls.

Run:

```bash
node --test tests/publishing/instagram-oauth.test.mjs --test-name-pattern="OAuth start|valid start|start response|start rate"
```

Expected RED: start module does not exist.

- [ ] **Step 2: implement minimal start handler**

Require same-origin `Origin`, compatible `Sec-Fetch-Site` when present, canonical HTTPS request URL, JSON content type, bounded content length/body, exactly one body property, explicit client registry equality, and a coarse tenant/client rate-limit adapter that is server-side and injectable. Generate one state/transaction; collision retries with a fresh nonce but never overwrites. Return `Cache-Control: no-store`, `Pragma: no-cache`, `Referrer-Policy: no-referrer`, JSON content type, and no CORS allow-origin header. Map errors to fixed safe messages.

- [ ] **Step 3: verify GREEN and response leakage**

```bash
node --test tests/publishing/instagram-oauth.test.mjs --test-name-pattern="OAuth start|valid start|start response|start rate"
git diff --check
```

Expected: 11 focused tests PASS and none of the three sentinel strings appears in serialized responses/headers/log calls.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/instagram-oauth-start.mjs tests/publishing/instagram-oauth.test.mjs
git commit -m "feat: add authenticated Instagram OAuth start"
```

---

### Task 7: One-use OAuth callback and secure binding (TDD)

**Files:**
- Create: `netlify/functions/instagram-oauth-callback.mjs`
- Modify: `tests/publishing/instagram-oauth.test.mjs`

**Interface:** `GET /.netlify/functions/instagram-oauth-callback`. It accepts provider `state` plus exactly one of `code` or denial fields. Tenant and return-destination ID come exclusively from the immutable transaction. Resolve only `growthwise-dev-integration` to `<GROWTHWISE_PUBLIC_ORIGIN>/instagram-dev.html?instagram=connected|cancelled|attention` and `dexter-integration` to `<GROWTHWISE_PUBLIC_ORIGIN>/?instagram=connected|cancelled|attention`. The callback request has no accepted `return_to`, destination, redirect URI, path, URL, or `business_id`. An unknown stored destination fails before provider exchange with a generic no-store `400` response and no `Location` header.

- [ ] **Step 1: write RED callback tests**

Exact names:

```text
callback rejects missing duplicate malformed and bad-HMAC state before exchange
callback rejects expired and replayed state before exchange
concurrent callbacks produce one exchange and one credential write winner
callback ignores or rejects a changed business_id and uses transaction tenant
callback uses the immutable transaction return destination
callback input cannot alter the return destination
unknown transaction return destination fails closed
provider denial consumes the transaction and redirects cancelled safely
code exchange error consumes failed and redirects attention safely
provider raw error and sentinel secrets do not appear in response headers redirect logs or user errors
wrong Instagram identity is rejected without active binding
empty or ambiguous Instagram identity is rejected without active binding
duplicate account binding to a second tenant is rejected
successful callback encrypts binds and marks consumed_success
successful callback redirects only to fixed connected hint
growthwise-dev successful callback returns to the development integration page
Dexter successful callback returns to the Dexter integration page
rolled-back credential binding never redirects connected
callback rejects duplicate unexpected query parameters and oversized query
```

Run:

```bash
node --test tests/publishing/instagram-oauth.test.mjs --test-name-pattern="callback|provider denial|code exchange|wrong Instagram|duplicate account|rolled-back binding"
```

Expected RED: callback module does not exist.

- [ ] **Step 2: implement callback orchestration**

Validate exact state grammar/HMAC, atomically claim the unexpired pending transaction with the guarded SQL update, validate its immutable destination ID against the server allowlist, and obtain the sole returned row before provider work. Handle denial as `consumed_denied`. Exchange code server-side, perform the approved long-lived exchange, verify one professional identity, encrypt the payload, and transactionally enforce unique ownership plus credential write before marking `consumed_success`. Any terminal failure marks `consumed_failed` and redirects to the transaction destination's fixed `attention` URL; an unknown destination or database ambiguity never redirects connected. Enforce time/size/schema limits in provider helper. Set no-store/no-referrer headers. Do not reflect raw query/provider errors.

- [ ] **Step 3: verify GREEN and all OAuth tests**

```bash
node --test tests/publishing/instagram-oauth.test.mjs
node --test tests/publishing/instagram-crypto.test.mjs tests/publishing/instagram-store.test.mjs tests/publishing/instagram-oauth-provider.test.mjs
git diff --check
git diff -- netlify/functions/instagram-oauth-callback.mjs tests/publishing/instagram-oauth.test.mjs
```

Expected: all OAuth tests PASS; exactly one winner in concurrency test; sentinel scan in test assertions is clean.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/instagram-oauth-callback.mjs tests/publishing/instagram-oauth.test.mjs
git commit -m "feat: complete one-use Instagram OAuth callback"
```

---

### Task 8: Encrypted-store-first connection health migration (TDD)

**Files:**
- Modify: `netlify/functions/instagram-connection.mjs`
- Modify: `tests/publishing/instagram-connection.test.mjs`
- Modify only to add a non-secret fallback policy flag if required: `clients/growthwise-dev.json`, `clients/dexters-hats.json`

**Interface:** Preserve authenticated `GET` and public `{ business_id, state, checked_at, account?: { username, name }, action? }`. Add injected `readCredential`, `decryptCredential`, provider verifier, and `legacyFallbackEnabled`. A stored database row always takes precedence. The legacy environment references are considered only when no row exists, deployment is explicitly development, and that tenant's fallback policy is explicitly enabled.

- [ ] **Step 1: extend RED health tests**

Exact new/updated names:

```text
no OAuth credential and no approved fallback returns Not Connected
valid stored OAuth credential and active binding returns Connected
Connected requires non-expired token and current exact identity match
expired or revoked credential returns Needs Attention
pending corrupt undecryptable or mismatched credential returns Needs Attention
stored bad credential never falls back to legacy token
legacy development fallback remains available only when explicitly enabled
cross-tenant credential or account binding fails closed
connection response never contains account ID token ciphertext expiry or raw Meta error
```

Retain existing method/auth/unknown-tenant and wrong/ambiguous-account tests.

Run:

```bash
node --test tests/publishing/instagram-connection.test.mjs
```

Expected RED: stored credential dependencies/precedence are absent.

- [ ] **Step 2: implement minimal migration**

Check for any primary row before considering fallback. Query by authenticated tenant, verify status and binding-key/AAD context, check local expiry, decrypt, call identity, and require exact stable ID. On success update only safe identity/`last_verified_at` with a parameterized tenant-scoped statement. Convert revoked/invalid-token to `needs_attention`; temporary provider failure returns safe **Needs Attention** without exposing details. Never silently rewrite account ownership.

- [ ] **Step 3: verify GREEN and legacy regressions**

```bash
node --test tests/publishing/instagram-connection.test.mjs
npm run test:publishing
git diff --check
git diff -- netlify/functions/instagram-connection.mjs tests/publishing/instagram-connection.test.mjs clients/growthwise-dev.json clients/dexters-hats.json
```

Expected: health tests and full suite PASS; existing legacy development test remains green; public response keys stay allowlisted.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/instagram-connection.mjs tests/publishing/instagram-connection.test.mjs
git add clients/growthwise-dev.json clients/dexters-hats.json
git commit -m "feat: prefer encrypted Instagram connection health"
```

Omit unchanged client files from the actual commit.

---

### Task 9: Reusable connection UI and authoritative return UX (TDD)

**Files:**
- Create: `assets/instagram-connection.mjs`
- Create: `tests/publishing/instagram-connection-ui.test.mjs`
- Create: `instagram-dev.html`
- Modify narrowly: `index.html`

**Interface:** The controller receives `businessId`; no account username/ID is hard-coded. `loadHealth()` fetches the health endpoint with `X-GrowthWise-Key`. `connect()` POSTs `{ business_id }` with JSON and `X-GrowthWise-Key`, validates the response has only `authorization_url`, parses it, requires HTTPS and the exact Meta authorization origin exported/configured from the verified provider contract, then calls injected `navigate(url)`. `consumeReturnHint(url)` recognizes only `connected|cancelled|attention`, removes the query through `history.replaceState`, and always calls `loadHealth`; it never sets Connected itself.

- [ ] **Step 1: add RED UI tests without real navigation**

Exact names:

```text
component renders Not Connected Connect Connecting Connected and Needs Attention states
component displays only Connected to username safe identity
connect sends X-GrowthWise-Key and business_id to same-origin start
connect rejects non-HTTPS wrong-origin and extra-field authorization responses
connect response never exposes or stores token code app secret or state secret
return query accepts only connected cancelled and attention hints
return query is removed immediately and never establishes Connected
both integration pages import and mount the exact same reusable component
growthwise-dev page requests health and starts OAuth only for growthwise-dev
Dexter page requests health and starts OAuth only for dexters-hats
future tenant IDs use the same controller path without tenant-specific OAuth logic
```

Use a minimal fake root with deterministic `render` assertions or isolate pure reducer/view-model functions; do not add a DOM framework dependency.

Run:

```bash
node --test tests/publishing/instagram-connection-ui.test.mjs
```

Expected RED: UI module does not exist.

- [ ] **Step 2: implement module and narrow Dexter bootstrap**

Render buttons/text with `textContent`, not untrusted HTML. Disable Connect/Reconnect while starting. Do not read callback code/state. Do not persist OAuth data. In `index.html`, add only the component container, module import, and bootstrap that passes the active configured tenant (`dexters-hats`) and existing session-scoped admin-key getter. Create `instagram-dev.html` as a small beta test harness that imports that exact module and mounts it with `businessId: "growthwise-dev"` under the same existing temporary admin-key entry/header boundary. It contains no token, account ID, app/provider secret, credential, or `growth.wise1` allowlist. The module remains tenant-parameterized; neither page duplicates OAuth/health logic. Do not alter Square/Facebook submit/success code.

Document in the page and runbook that `instagram-dev.html` exists only for current `growthwise-dev` beta acceptance. Do not create static pages for future customers: future SaaS onboarding supplies authenticated tenant context to the same component in the shared application shell.

- [ ] **Step 3: verify GREEN and inspect the perceptible UI**

```bash
node --test tests/publishing/instagram-connection-ui.test.mjs tests/publishing/dexter-shadow-bridge.test.mjs
npm run test:publishing
git diff --check
git diff --word-diff=plain -- index.html
git diff -- instagram-dev.html assets/instagram-connection.mjs
git diff --exit-code HEAD -- automotive-pilot.html netlify/functions/facebook-post.mjs netlify/functions/add-product.mjs
```

Expected: UI and Dexter bridge tests PASS; protected files unchanged; `index.html` diff contains only the integration panel/bootstrap; `instagram-dev.html` is a credential-free harness of the same component. Run both pages locally with mocked safe endpoint responses. Capture development-page screenshots of **Not Connected**, **Connected to @username**, and **Needs Attention**, plus the Dexter panel. Store screenshots outside Git or in the PR evidence system, not as repository assets.

- [ ] **Step 4: commit**

```bash
git add assets/instagram-connection.mjs tests/publishing/instagram-connection-ui.test.mjs instagram-dev.html index.html
git commit -m "feat: add reusable Instagram connection settings"
```

---

### Task 10: Safety regressions and leakage scan automation (TDD)

**Files:**
- Create: `tests/publishing/instagram-safety-regression.test.mjs`
- Modify: `package.json` only to add a deterministic `test:instagram` script covering all new non-preflight Instagram tests

**Interface:** `npm run test:instagram` runs crypto, store, provider, endpoint, health, UI, and safety files. The safety test reads tracked runtime/frontend/client files and enforces negative/static invariants without scanning `.git`, documentation examples, or synthetic test sentinels.

- [ ] **Step 1: write RED static/regression tests**

Exact names:

```text
runtime and client files contain no instagram_business_content_publish
runtime files contain no Instagram publish or media-container endpoint
Publishing Core source preserves live_sent false invariant
protected Auto City Square and Facebook files match branch baseline
frontend assets contain no server environment secret names except the admin header name
development harness contains no growth.wise1 allowlist account ID token or provider credential
development and Dexter pages import the same connection component once
client JSON contains no token code secret or credential values
all user-facing response and logger captures exclude sentinel secrets
```

For protected files, compare content hashes recorded from `origin/platform-v1` in the test fixture constants generated in Task 1; `index.html` is deliberately reviewed separately and is not in this hash group. For publish/container guards, parse/search runtime files for verified provider endpoint fragments and forbidden permission, not generic prose.

Run:

```bash
node --test tests/publishing/instagram-safety-regression.test.mjs
```

Expected RED: script/test invariants are not yet defined; if it reveals a real safety regression, fix the originating task rather than weakening the assertion.

- [ ] **Step 2: add minimal safety test and test script**

Add:

```json
"test:instagram": "node --test tests/publishing/instagram-crypto.test.mjs tests/publishing/instagram-store.test.mjs tests/publishing/instagram-oauth-provider.test.mjs tests/publishing/instagram-oauth.test.mjs tests/publishing/instagram-connection.test.mjs tests/publishing/instagram-connection-ui.test.mjs tests/publishing/instagram-safety-regression.test.mjs"
```

Do not add production publishing code to satisfy any assertion.

- [ ] **Step 3: verify GREEN and full regression**

```bash
npm run test:instagram
npm run test:publishing
git diff --check
git diff -- package.json tests/publishing/instagram-safety-regression.test.mjs
```

Expected: all Instagram and publishing tests PASS with counts recorded; safety tests prove no publishing/container/webhook behavior was introduced.

- [ ] **Step 4: commit**

```bash
git add package.json tests/publishing/instagram-safety-regression.test.mjs
git commit -m "test: lock Instagram OAuth safety boundaries"
```

---

### Task 11: Operator runbook and migration guardrails

**Files:**
- Modify: `docs/INSTAGRAM_CONNECTION_RUNBOOK.md`

**Interface/documented operations:** Name the Meta app **GrowthWise Social**; show the verified literal `GROWTHWISE_PUBLIC_ORIGIN` and exact callback; list (without values) `GROWTHWISE_ADMIN_KEY`, `GROWTHWISE_INSTAGRAM_APP_ID`, `GROWTHWISE_INSTAGRAM_APP_SECRET`, `GROWTHWISE_INSTAGRAM_OAUTH_STATE_SECRET`, `GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET`, and `GROWTHWISE_INSTAGRAM_CREDENTIAL_ENCRYPTION_KEY`; document key encodings/versioning; give the `growth.wise1` identity-only tester procedure; explain all three health states; document reconnect and failure triage; and state publishing/webhooks remain disabled.

- [ ] **Step 1: update the runbook with exact safe operator steps**

Include pre-deployment configuration verification but do not deploy. Instruct operators to enter values only in Netlify server environment controls, never browser/client JSON/Git/support chat. Document the first acceptance sequence exactly: GrowthWise development page (`/instagram-dev.html`) → **Connect Instagram** for `growthwise-dev` → GrowthWise Social authorization → select/authorize the professional `growth.wise1` tester account → safe OAuth callback → server-selected return to `/instagram-dev.html?instagram=connected` → hint removed → authoritative `growthwise-dev` health check → `Connected to @growth.wise1`. Do not create or paste an access token. Then document Dexter using the same component/endpoints with `dexters-hats` and the server-selected `/` destination. State that `growth.wise1` is acceptance data, never an allowed-account constant. Include rollback: disable OAuth UI/start, retain encrypted records, and keep legacy fallback development-only; never enable fallback after a bad stored record.

- [ ] **Step 2: run documentation/static checks**

```bash
git diff --check
rg -n "GrowthWise Social|GROWTHWISE_PUBLIC_ORIGIN|instagram-oauth-callback|GROWTHWISE_INSTAGRAM_ACCOUNT_BINDING_SECRET|growth\.wise1|Connected|Needs Attention|publishing remains disabled" docs/INSTAGRAM_CONNECTION_RUNBOOK.md
! rg -n "instagram_business_content_publish|access_token=|client_secret=" docs/INSTAGRAM_CONNECTION_RUNBOOK.md
git diff -- docs/INSTAGRAM_CONNECTION_RUNBOOK.md
```

Expected: required safe instructions found; forbidden permission/query-secret examples absent.

- [ ] **Step 3: commit**

```bash
git add docs/INSTAGRAM_CONNECTION_RUNBOOK.md
git commit -m "docs: add Instagram OAuth operations runbook"
```

---

### Task 12: Fresh final verification and draft PR

**Files:** No product-file changes are allowed in this task. If verification finds a defect, return to the owning task, add/adjust the failing test, fix minimally, rerun that task, and create a focused fix commit before restarting this task from the first command.

- [ ] **Step 1: install reproducibly and run fresh suites**

From a clean checkout/worktree of the feature branch:

```bash
npm install --ignore-scripts --no-audit --no-fund
node --test tests/integration/instagram-database.test.mjs
npm run test:instagram
npm run test:publishing
git diff --check origin/platform-v1...HEAD
```

Record exact test counts as `PASS`, `FAIL`, or `NOT TESTABLE`. The database integration suite may be **NOT TESTABLE** when no explicitly configured isolated non-production context is available; record it as a required real-environment acceptance test before merge/deployment, without weakening or falling back. Every deterministic suite must have zero relevant failures/skips.

- [ ] **Step 2: run repository leakage and forbidden-capability scans**

Use synthetic sentinel names plus common assignment patterns; inspect every match rather than printing secret-bearing environment values:

```bash
git grep -n -E 'SENTINEL_(ADMIN_KEY|APP_SECRET|TOKEN)_DO_NOT_LEAK' -- ':!tests/**' ':!docs/**' && exit 1 || true
git grep -n 'instagram_business_content_publish' -- ':!docs/**' ':!tests/**' && exit 1 || true
git grep -n -E 'media_publish|media/container|/media_publish|container_id' -- netlify core integrations assets clients && exit 1 || true
git grep -n -E '(access[_-]?token|app[_-]?secret|encryption[_-]?key|state[_-]?secret|binding[_-]?secret)[[:space:]]*[:=][[:space:]]*["'"'][^"'"']+["'"']' -- ':!tests/**' ':!docs/**' && exit 1 || true
```

Expected: no runtime/client/frontend matches. Documentation references names only; tests contain synthetic sentinels only. Also inspect captured response/header/redirect/logger assertions from `npm run test:instagram`.

- [ ] **Step 3: review the full branch diff and protected behavior**

```bash
git diff --stat origin/platform-v1...HEAD
git diff --name-status origin/platform-v1...HEAD
git diff --exit-code origin/platform-v1...HEAD -- automotive-pilot.html netlify/functions/facebook-post.mjs netlify/functions/add-product.mjs
git diff origin/platform-v1...HEAD -- index.html
git diff origin/platform-v1...HEAD -- instagram-dev.html assets/instagram-connection.mjs
git diff origin/platform-v1...HEAD -- core/publishing integrations/channels netlify/functions/publishing-shadow.mjs
git log --oneline --decorate origin/platform-v1..HEAD
test "$(git rev-parse main)" = "$(cat /tmp/growthwise-main-before)"
git status --short
```

Expected: protected-file commands show no diff; `index.html` is narrowly scoped; Publishing Core has no behavior diff except tests that guard it; planned commits are meaningful; `main` SHA is unchanged; worktree is clean.

- [ ] **Step 4: complete the spec-to-plan acceptance audit**

Check every approved spec heading against implemented tests/code/runbook: product boundary, current findings/migration, configuration/redirect, both endpoints, state/replay, encrypted storage, unique binding, token lifecycle, health, UI, threats, test matrix, operations, exclusions, preflight decisions, and self-review. Confirm explicitly:

```text
PASS owner can start authorization without Paul handling a token
PASS callback binds exactly one professional account to one tenant
PASS growthwise-dev returns only to the development integration harness
PASS Dexter returns only to the Dexter integration page
PASS callback input cannot alter the immutable allowlisted destination
PASS no arbitrary or open redirect is possible
PASS authoritative health can report Connected with username only
PASS tenant/identity/crypto/storage/provider ambiguity fails closed
PASS live_sent remains false
PASS no Instagram publishing/container endpoint or permission exists
PASS no webhook was configured
PASS no deployment occurred
PASS no external Meta mutation occurred
PASS main was untouched
```

Any false item is a FAIL, not a caveat.

- [ ] **Step 5: create/update only a draft PR targeting `platform-v1`**

Push the feature branch and create a **draft** PR with base `platform-v1`. Include exact test counts, preflight evidence, screenshots, decision outcomes, migration/fallback status, protected-file confirmation, and explicit no-deploy/no-Meta-mutation statements. Do not merge automatically.

---

## Commit sequence

1. `docs: move Instagram OAuth state to PostgreSQL`
2. `feat: add separated Instagram cryptography`
3. `feat: add one-use Instagram OAuth transactions`
4. `feat: store encrypted tenant Instagram credentials`
5. `feat: add verified Instagram OAuth provider contract`
6. `feat: add authenticated Instagram OAuth start`
7. `feat: complete one-use Instagram OAuth callback`
8. `feat: prefer encrypted Instagram connection health`
9. `feat: add reusable Instagram connection settings`
10. `test: lock Instagram OAuth safety boundaries`
11. `docs: add Instagram OAuth operations runbook`

Do not squash these during implementation review unless the reviewer explicitly requests it; each boundary corresponds to an independently reviewable security/TDD unit.

## Remaining decision gates

These are gates, not unresolved design placeholders:

1. Paul must confirm the canonical GrowthWise Netlify origin if repository/read-only site evidence cannot prove it.
2. Paul's approved first-party Meta Postman/provider contract unblocks implementation despite the Codex proxy. A material conflict found during later acceptance returns to architecture review; do not improvise PKCE or broader scopes.
3. An isolated real PostgreSQL/Netlify Database context must prove transaction and unique-constraint behavior before merge/deployment. If unavailable in Codex, report **NOT TESTABLE**; never use production or fall back to Blobs.

No implementation task requires Paul to create, copy, or paste an Instagram access token.

## Plan self-review checklist

- [ ] Every approved spec section maps to at least one task or final audit item.
- [ ] No unresolved placeholder marker or vague deferred action appears in an executable task.
- [ ] Function names, record statuses, keys, endpoint methods, response shapes, and tests are consistent across tasks.
- [ ] Each runtime task has a named RED test, expected failure, minimal GREEN implementation, pass command, diff review, and commit.
- [ ] OAuth state HMAC, account-binding HMAC, and credential encryption use independent secrets and rotation paths.
- [ ] Tenant is selected only at authenticated start and thereafter comes from the immutable transaction; every storage read/write validates it.
- [ ] Return destination is selected only from the verified tenant registry, persisted immutably in the transaction, and resolved through a fixed server allowlist; callback/browser inputs cannot alter it.
- [ ] No arbitrary/open redirect is possible: unknown destinations return a generic no-store error without a `Location` header.
- [ ] No task requests publishing permission, calls publishing/container APIs, configures webhooks, or changes Auto City/Dexter legacy behavior.
- [ ] The UI never treats the callback hint as connection truth and never receives a token/code/secret.
- [ ] `instagram-dev.html` is a credential-free beta acceptance harness for `growthwise-dev`; it and Dexter mount the same component, while future SaaS tenants use authenticated context in the shared shell rather than static per-customer pages.
- [ ] The implementation uses documented `@netlify/database` APIs, parameterized SQL, and one checked-out client per transaction; real integration acceptance is recorded separately when unavailable.
- [ ] The final result is self-service connection and authoritative `Connected to @username`, with no manual token work by Paul.
