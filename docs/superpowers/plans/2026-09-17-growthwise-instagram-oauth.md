# GrowthWise Instagram OAuth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a GrowthWise business owner click **Connect Instagram**, authorize one professional Instagram account, return safely, and see authoritative tenant-scoped connection health without Paul creating or pasting tokens.

**Architecture:** Add two small Netlify endpoints over shared OAuth, cryptography, provider, and strongly consistent Blob-store adapters. OAuth transactions are short-lived and one-use; credentials are AES-256-GCM encrypted; durable account uniqueness uses a secret independent from OAuth state signing. The encrypted store is primary and the current environment-reference path remains an explicitly gated development fallback. A parameterized browser component starts OAuth and renders health. No unit in this plan publishes, creates media containers, or registers webhooks.

**Tech Stack:** Node.js ES modules, built-in `node:test` / `node:assert/strict` / `node:crypto`, Netlify Functions, an implementation-verified exact version of `@netlify/blobs`, JSON client configuration, and the existing HTML/CSS/JavaScript application.

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
  - `instagramStore()` returns strongly consistent `growthwise-integrations-v1`
  - transaction methods: `createTransaction(record)`, `readTransaction(transactionKey)`, `beginTransaction({ transactionKey, now })`, `finishTransaction({ transactionKey, etag, status, now })`
  - binding/credential methods: `readCredential(businessId)`, `reserveAccountBinding(input)`, `writePendingCredential(input)`, `finalizeAccountBinding(input)`, `activateCredential(input)`, `compensateReservation(input)`, `readActiveBinding(input)`
  - abuse-control method: `consumeStartRateLimit({ businessId, bucketStartedAt, limit })`, backed by a tenant/minute record and conditional ETag updates
  - all exported persistence helpers accept `{ store }` injection for tests
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
- `tests/preflight/netlify-blobs-contract.test.mjs`

The added `_instagram-clients.mjs`, provider-focused test, UI module/test, preflight test, and safety test refine the approved expected units by separating client lookup, provider behavior, DOM-independent browser logic, live SDK semantics, and repository-wide negative assertions. This is smaller and easier to audit than putting those concerns in endpoint files.

### Record/status vocabulary

- OAuth transaction statuses: `pending`, `processing`, `consumed_success`, `consumed_failed`, `consumed_denied`, `expired`.
- Credential statuses: `pending`, `connected`, `needs_attention`.
- Public connection states: `Not Connected`, `Connected`, `Needs Attention`.
- Safe callback hints: `connected`, `cancelled`, `attention` only.
- Server-selected return destination IDs: `growthwise-dev-integration`, `dexter-integration` only. Browsers/provider callbacks cannot supply either ID.
- Transaction TTL: exactly 10 minutes, with expiry defined as `now >= expires_at`.

---

### Task 1: Mandatory preflight gate and reproducible Blob dependency

**This task must complete before Tasks 2–11. It performs read-only verification only.**

**Files:**
- Create: `docs/verification/instagram-oauth-preflight.md`
- Create: `tests/preflight/netlify-blobs-contract.test.mjs`
- Modify only after all probes pass: `package.json`
- Create only if generated by the repository's package manager: `package-lock.json`

**Interfaces/proof produced:**
- A verified literal `GROWTHWISE_PUBLIC_ORIGIN` and exact callback URI recorded without secrets.
- A dated table of official Meta URLs/contracts, permission, fields, PKCE result, and source links.
- A literal tested `@netlify/blobs` version and passing integration proof for `onlyIfNew`, `onlyIfMatch`, `getWithMetadata`/ETag, strong reads, stale-ETag rejection, and concurrent create contention.
- `package.json` changes from `"latest"` to the exact proven version only after proof succeeds.

- [ ] **Step 1: establish branch and protected-file baselines**

Run:

```bash
git fetch origin platform-v1
git switch -c feat/growthwise-instagram-oauth origin/platform-v1
git merge-base --is-ancestor 9a8d71dcec5e508d875ed21fd2aeb2e0842bc3ba HEAD
git branch --show-current
git diff --exit-code origin/platform-v1 -- automotive-pilot.html netlify/functions/facebook-post.mjs netlify/functions/add-product.mjs
git rev-parse main > /tmp/growthwise-main-before
```

Expected: the ancestor and protected-file commands PASS; branch name is not `main`. If the approved spec/plan commits are not already on the feature branch, cherry-pick only those documentation commits before continuing.

- [ ] **Step 2: verify the canonical GrowthWise origin without inventing it**

Inspect tracked Netlify configuration, repository remotes/docs, and read-only Netlify site metadata available to the execution environment. Do not infer the host from a preview URL or request headers. Record the authoritative HTTPS origin, its evidence source, and:

```text
<verified-origin>/.netlify/functions/instagram-oauth-callback
```

in `docs/verification/instagram-oauth-preflight.md`.

Expected: exactly one canonical HTTPS origin confirmed for the GrowthWise site. **STOP / DECISION NEEDED:** if it cannot be verified automatically or evidence conflicts, ask Paul to supply/confirm it. Do not proceed to provider/storage work.

- [ ] **Step 3: verify the current official Meta Instagram Login contract**

Using official Meta documentation only, record the current authorization endpoint, code-exchange endpoint, long-lived exchange/refresh availability and endpoints, `instagram_business_basic`, professional identity endpoint/fields, PKCE support/result, exact redirect matching rules, documentation URLs, and verification date. Explicitly record that neither publishing scope nor a publish/container endpoint is used.

Expected: the approved identity-only flow is supported. **STOP / DECISION NEEDED:** if official behavior materially conflicts with the spec—including permission, callback semantics, identity response, or required publishing permission—report the contradiction rather than improvising.

- [ ] **Step 4: write the failing Blob contract probe before pinning**

Create `tests/preflight/netlify-blobs-contract.test.mjs` with exactly these test names, using a unique test prefix and an explicitly configured non-production Netlify Blobs test context:

```text
getWithMetadata returns the current ETag after a strong write
onlyIfNew permits exactly one winner under concurrent create contention
onlyIfMatch accepts the current ETag and rejects a stale ETag
strong reads observe the winning conditional write
```

The test must clean up only its unique keys and print no values/bodies/headers. Initially import the candidate SDK package without altering `package.json`.

Run the repository test with the candidate version installed in an isolated temporary directory or with `npm install --no-save --package-lock=false` after recording the candidate version from official package metadata/changelog—not merely choosing whatever `latest` resolves to:

```bash
node --test tests/preflight/netlify-blobs-contract.test.mjs
```

Expected RED: FAIL before correct SDK/context wiring, or FAIL on any unsupported semantic. A skipped/not-testable result does not pass this gate.

- [ ] **Step 5: make the probe pass against real non-production Blob semantics**

Use the candidate version's documented exact signatures for `onlyIfNew`, `onlyIfMatch`, `getWithMetadata`, ETags, and `consistency: "strong"`. Run contention with at least 20 simultaneous create attempts and assert exactly one success. Update with the winning ETag, then repeat with that stale ETag and assert the stale write is rejected without changing stored content.

Run:

```bash
node --test tests/preflight/netlify-blobs-contract.test.mjs
```

Expected GREEN: 4 tests PASS, 0 fail, 0 skipped. **STOP / DECISION NEEDED:** if a real non-production context is unavailable or any semantic cannot be proven, propose the smallest transactional store alternative; do not weaken replay/account uniqueness.

- [ ] **Step 6: pin only the proven exact version and run regressions**

Change `package.json` from `"@netlify/blobs": "latest"` to the literal version proven above. Generate/commit a lockfile if `npm install` creates one. Record the literal version and four-test output in the preflight document.

Run:

```bash
npm install --ignore-scripts --no-audit --no-fund
node --test tests/preflight/netlify-blobs-contract.test.mjs
npm run test:publishing
git diff --check
git diff -- package.json package-lock.json docs/verification/instagram-oauth-preflight.md tests/preflight/netlify-blobs-contract.test.mjs
```

Expected: preflight 4/4 PASS; existing publishing suite PASS with its exact count recorded. `package.json` has an exact version, not a range/tag. Review ensures no secret/test context credential was written.

- [ ] **Step 7: commit the closed gate**

```bash
git add package.json docs/verification/instagram-oauth-preflight.md tests/preflight/netlify-blobs-contract.test.mjs
test ! -f package-lock.json || git add package-lock.json
git diff --cached --check
git commit -m "build: verify and pin Netlify Blobs contract"
```

---

### Task 2: Cryptographic primitives (TDD)

**Files:**
- Create: `netlify/functions/_instagram-crypto.mjs`
- Create: `tests/publishing/instagram-crypto.test.mjs`

**Interfaces:** Implement the `createInstagramCrypto` factory from the file map. Configuration maps are versioned (`{ current: { id, key }, previous?: [...] }`). `createState()` returns `{ state, nonceHash, keyVersion }`; browser state contains only `v1.<nonce>.<tag>`. `accountBindingKey(s)` returns internal Blob keys. The encrypted token envelope is `{ algorithm: "A256GCM", key_version, iv, ciphertext }` with the authentication tag included in `ciphertext`. AAD is the canonical UTF-8 string `growthwise-integrations-v1\ncredential-v1\n<business_id>\ninstagram\n<account_id>`.

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

### Task 3: One-use OAuth transaction storage (TDD)

**Files:**
- Create: `netlify/functions/_instagram-store.mjs`
- Create: `tests/publishing/instagram-store.test.mjs`

**Interfaces:** First implement only `instagramStore`, `transactionKey`, `createTransaction`, `readTransaction`, `beginTransaction`, `finishTransaction`, and `consumeStartRateLimit`. Store keys are constructed internally. `beginTransaction` strong-reads metadata, validates embedded/key tenant-independent transaction identity, rejects `now >= expires_at`, and uses `onlyIfMatch` to change only `pending` to `processing`. It returns the new record/ETag to the sole winner. Rate limiting stores only tenant, UTC minute bucket, count, and expiry—never an admin key, IP address, user agent, or state—and uses `onlyIfNew`/ETag retry to enforce a configured count across function instances.

- [ ] **Step 1: add RED transaction tests**

Add an in-memory conditional-store fake that models ETags and the verified SDK contract. Exact test names:

```text
transaction create is onlyIfNew and stores a ten-minute tenant-bound pending record
missing malformed and expired transactions cannot begin
pending transaction transitions atomically to processing once
replayed transaction is rejected before provider work
concurrent beginTransaction calls produce exactly one winner
finishTransaction requires the current ETag and a terminal status
start rate limit atomically rejects attempts above the tenant minute limit
```

Run:

```bash
node --test tests/publishing/instagram-store.test.mjs --test-name-pattern="transaction|beginTransaction|finishTransaction"
```

Expected RED: exports are missing.

- [ ] **Step 2: implement transaction persistence**

Use `getStore({ name: "growthwise-integrations-v1", consistency: "strong" })`; use `getWithMetadata` plus verified ETag conditional calls. Store `schema_version`, provider, nonce hash, immutable `business_id`, issued/expiry timestamps, status, the server-selected allowlisted return destination ID copied from the verified tenant registry, and optional encrypted/opaque PKCE verifier only if preflight verified PKCE. Never store raw state, admin key, code, provider response, caller path, or caller URL. Error types distinguish internal `not_found`, `expired`, `replayed`, `conflict`, and `corrupt` without including records.

- [ ] **Step 3: verify GREEN and real contract regression**

```bash
node --test tests/publishing/instagram-store.test.mjs --test-name-pattern="transaction|beginTransaction|finishTransaction"
node --test tests/preflight/netlify-blobs-contract.test.mjs
git diff --check
```

Expected: 7 focused tests and 4 contract tests PASS.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/_instagram-store.mjs tests/publishing/instagram-store.test.mjs
git commit -m "feat: add one-use Instagram OAuth transactions"
```

---

### Task 4: Encrypted credentials and unique account binding (TDD)

**Files:**
- Modify: `netlify/functions/_instagram-store.mjs`
- Modify: `tests/publishing/instagram-store.test.mjs`

**Interfaces:** Add the binding/credential methods in the file map. Credential key is exactly `business/<business_id>/integration/instagram/credential`. Reverse keys come only from `crypto.accountBindingKeys(accountId)`. Binding protocol is reserve (`pending`, `onlyIfNew`) → write encrypted credential (`pending`) → finalize binding (`active`, current ETag) → activate credential (`connected`, current ETag). `compensateReservation` deletes only a matching transaction/version reservation. Reads require caller tenant equality, embedded tenant equality, active reverse ownership, and decryptable matching AAD.

- [ ] **Step 1: add RED storage tests**

Exact names:

```text
encrypted credential round trip succeeds for its tenant and active binding
plaintext token never appears in Blob serialization
cross-tenant credential read is rejected before decryption
wrong tenant or account AAD cannot decrypt a moved credential
duplicate account binding to a second tenant is rejected
concurrent account reservations produce exactly one owner
reserve write finalize activates both records
credential write failure compensates only its own reservation
finalize or activate failure never produces Connected
binding-secret migration checks both indexes and fails on ownership disagreement
```

Run:

```bash
node --test tests/publishing/instagram-store.test.mjs
```

Expected RED: missing credential/binding methods.

- [ ] **Step 2: implement minimal binding protocol**

Validate every `business_id` as one key segment and every loaded record's embedded tenant. Require conditional writes at every status transition. Never list tenant prefixes to infer ownership. During binding-key rotation, dual-read all configured versions, reject conflicting owners, write/finalize the current version, and preserve previous indexes until the migration described in the runbook is verified. Return metadata/safe status; never return plaintext token from store APIs except the narrowly named internal decrypt method used by provider health.

- [ ] **Step 3: verify GREEN and broad storage regression**

```bash
node --test tests/publishing/instagram-crypto.test.mjs tests/publishing/instagram-store.test.mjs
node --test tests/preflight/netlify-blobs-contract.test.mjs
git diff --check
git diff -- netlify/functions/_instagram-store.mjs tests/publishing/instagram-store.test.mjs
```

Expected: all crypto/store/contract tests PASS; serialized fake-store values contain none of the sentinel token.

- [ ] **Step 4: commit**

```bash
git add netlify/functions/_instagram-store.mjs tests/publishing/instagram-store.test.mjs
git commit -m "feat: store encrypted tenant Instagram credentials"
```

---

### Task 5: Verified provider helper and client registry (TDD)

**Files:**
- Create: `netlify/functions/_instagram-oauth.mjs`
- Create: `netlify/functions/_instagram-clients.mjs`
- Create: `tests/publishing/instagram-oauth-provider.test.mjs`
- Modify only if the provider contract requires configuration flags, never secrets: `clients/growthwise-dev.json`, `clients/dexters-hats.json`

**Interfaces:** Use only the literal endpoints/scope/fields confirmed in Task 1. `buildAuthorizationUrl` receives `{ appId, callbackUri, state, codeChallenge? }`; it has no return-URL or business-ID argument. Provider requests use injected `fetchImpl`, `AbortSignal.timeout`, explicit response-byte limits, exact JSON schema validation, and authorization headers/body placement required by the verified contract. `verifyProfessionalIdentity` returns only normalized internal `{ accountId, username, name }`. `InstagramProviderError` carries a safe enum (`denied`, `exchange_failed`, `invalid_identity`, `temporarily_unavailable`) and no raw body/request.

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

If preflight proves long-lived exchange unsupported for this flow, replace the named long-lived-exchange test with `unsupported long-lived exchange is disabled explicitly` and assert no exchange call occurs. If PKCE is unsupported, assert the authorization URL omits PKCE and record that verified decision; do not simulate unsupported parameters.

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
partial reverse-binding writes never redirect connected
callback rejects duplicate unexpected query parameters and oversized query
```

Run:

```bash
node --test tests/publishing/instagram-oauth.test.mjs --test-name-pattern="callback|provider denial|code exchange|wrong Instagram|duplicate account|partial reverse"
```

Expected RED: callback module does not exist.

- [ ] **Step 2: implement callback orchestration**

Validate exact state grammar/HMAC, strong-read transaction, validate its destination ID against the server allowlist, and win `pending → processing` before provider work. Handle denial as `consumed_denied`. Exchange code server-side, perform verified long-lived exchange when supported, verify one professional identity, enforce duplicate binding, encrypt payload, execute reserve/write/finalize/activate, then mark `consumed_success`. Any terminal failure marks `consumed_failed` using the current ETag and redirects to the transaction destination's fixed `attention` URL; an unknown destination or storage ambiguity never redirects connected. Enforce time/size/schema limits in provider helper. Set no-store/no-referrer headers. Do not reflect raw query/provider errors.

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

**Interface:** Preserve authenticated `GET` and public `{ business_id, state, checked_at, account?: { username, name }, action? }`. Add injected `readCredential`, `readActiveBinding`, `decryptCredential`, provider verifier, and `legacyFallbackEnabled`. A stored record always takes precedence. The legacy environment references are considered only when no store record exists, deployment is explicitly development, and that tenant's fallback policy is explicitly enabled.

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
cross-tenant credential or reverse binding fails closed
connection response never contains account ID token ciphertext expiry or raw Meta error
```

Retain existing method/auth/unknown-tenant and wrong/ambiguous-account tests.

Run:

```bash
node --test tests/publishing/instagram-connection.test.mjs
```

Expected RED: stored credential dependencies/precedence are absent.

- [ ] **Step 2: implement minimal migration**

Check for any primary record before considering fallback. Verify status, active reverse binding, local expiry, decrypt with tenant/account AAD, call identity, and require exact stable ID. On success update only safe identity/`last_verified_at` with a conditional record write. Convert revoked/invalid-token to `needs_attention`; temporary provider failure returns safe **Needs Attention** without exposing details. Never silently rewrite account ownership.

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
node --test tests/preflight/netlify-blobs-contract.test.mjs
npm run test:instagram
npm run test:publishing
git diff --check origin/platform-v1...HEAD
```

Record exact test counts as `PASS`, `FAIL`, or `NOT TESTABLE`. The Blob contract may not be marked PASS unless the real non-production semantics ran; `NOT TESTABLE` blocks the PR from implementation-ready status and becomes **DECISION NEEDED**. Every other suite must have zero failures/skips relevant to the feature.

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

1. `build: verify and pin Netlify Blobs contract`
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
2. Official current Meta documentation must confirm the identity-only contract, including PKCE and long-lived-token behavior; a material conflict returns to architecture review.
3. A literal `@netlify/blobs` version must prove conditional-write/ETag/strong-consistency behavior in a real non-production context. Failure requires approval of a transactional alternative.

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
- [ ] The dependency is pinned only after real semantic proof, and failure blocks implementation.
- [ ] The final result is self-service connection and authoritative `Connected to @username`, with no manual token work by Paul.
