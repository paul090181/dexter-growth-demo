# GrowthWise Connector Invitations Design

## Scope

Add a reusable, billing-independent customer invitation flow for supported business integrations on Deploy Preview #14. The flow must serve configured pilots such as `dexters-hats` and database-backed tenants while preserving existing admin Instagram workflows, tenant isolation, and Dexter's pilot billing state. Production, live Meta configuration, Facebook OAuth, and `GROWTHWISE_META_ACCOUNT_MAP` are excluded.

## Security model

- An authorized operator creates a 24-hour invitation for one existing `business_id` and an allowlisted subset of `instagram` and `facebook`.
- Invitation and connector-session tokens contain 256 bits of cryptographic randomness. Only SHA-256 hashes are stored. Raw values are never logged or persisted.
- The raw invitation appears once in the returned URL fragment. The customer page captures it in memory, removes the fragment with `history.replaceState` before any network or navigation action, and exchanges it in a same-origin POST body.
- Redemption atomically locks and validates the invitation, creates a fixed 30-minute connector session, and marks the invitation used. Expired, revoked, used, malformed, or concurrently redeemed invitations fail closed.
- The raw session token exists only in a `Secure`, `HttpOnly`, `SameSite=Lax`, path-scoped cookie. Server authorization loads its hash and verifies active status, fixed expiration, exact `business_id`, and the requested connector.
- Neither invitation nor session lifetime extends through use. A redeemed invitation remains unusable after its session expires.
- Responses use `Cache-Control: no-store` and restrictive referrer policy. The customer page loads no third-party resources.

## Server components

1. `connector_invitations` stores a token hash, exact tenant, connector list, fixed expiry, and revoked/used timestamps.
2. `connector_sessions` stores a session-token hash, exact tenant, inherited connector list, fixed expiry, and revocation timestamp.
3. An admin-only creation endpoint validates the tenant against configured pilot tenants or `growthwise_tenants`, then returns the raw fragment URL once. It does not support tenant self-service.
4. A public exchange endpoint accepts only the raw invitation token, performs atomic redemption, and sets the connector-session cookie.
5. A session endpoint returns only the authenticated tenant's safe display name and connector capabilities. Facebook is explicitly unavailable.
6. Instagram connection health and OAuth start accept either the existing administrator credential or a valid connector session for the same tenant with `instagram` allowed. Caller input cannot replace the session tenant.
7. Session-started Instagram OAuth uses a fixed connection-page return destination. Existing operator return destinations remain unchanged.

## Customer page

`connect-accounts.html` is tenant-neutral. It exchanges a fragment invitation, then renders safe server state:

- Instagram: `Not connected`, `Connected`, or `Needs attention`, with Connect/Reconnect when authorized.
- Facebook: `Setup unavailable` and no active connection action.

The page never requests or stores an admin key, tenant access key, provider token, or other credential.

## Acceptance

Automated tests cover 256-bit generation, hash-only persistence, fixed expiry, revocation, single-use and concurrent redemption, exact tenant and connector binding, secret-free URLs/storage/logging, cookie properties, cross-tenant denial, Instagram admin/session authorization, Facebook unavailable state, Dexter pilot preservation, and absence of billing mutation. Preview acceptance creates one new Dexter invitation, opens it in a fresh browser session, verifies the page and Instagram start readiness without completing OAuth, confirms Facebook remains unavailable, proves cross-tenant denial and Dexter's unchanged pilot state, and makes no production or live Meta change.
