# GrowthWise Instagram OAuth preflight

**Date:** 2026-09-17
**Status:** approved inputs recorded; isolated Netlify Database acceptance passed on 2026-09-18; manual Instagram OAuth acceptance remains

## Branch and safety boundary

Implementation continues only on `feat/growthwise-instagram-oauth-replacement` from the `platform-v1` baseline `2c4644af8bd915dadc0450f3394b55c91c0bea3c`. It must not deploy, merge, modify `main`, mutate Meta configuration, enable publishing/webhooks, or change the protected Auto City/Facebook files.

## Canonical GrowthWise origin

Paul confirmed the stable Netlify production-domain value (not a deploy preview or branch deploy):

```text
GROWTHWISE_PUBLIC_ORIGIN=https://euphonious-beijinho-db4b4d.netlify.app
```

The exact callback to register for GrowthWise Social is:

```text
https://euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/instagram-oauth-callback
```

This task records configuration only and does not deploy to or mutate that site.

## Approved provider contract

Direct access to `developers.facebook.com` was blocked by the Codex environment's network proxy. Paul approved use of current first-party Meta Postman documentation plus the following explicit implementation contract:

| Concern | Approved value |
|---|---|
| Product/accounts | Instagram API with Instagram Login; professional Business/Creator accounts |
| Authorization | `https://www.instagram.com/oauth/authorize` |
| Code exchange | `POST https://api.instagram.com/oauth/access_token` |
| Professional API host | `https://graph.instagram.com` |
| Long-lived exchange | `GET https://graph.instagram.com/access_token`, `grant_type=ig_exchange_token` |
| Long-lived refresh | `GET https://graph.instagram.com/refresh_access_token`, `grant_type=ig_refresh_token` |
| Identity | `GET https://graph.instagram.com/me`, minimum account ID and username fields |
| Scope | exactly `instagram_business_basic` |
| PKCE | do not add by assumption; stop and intentionally revise if later acceptance proves a concrete requirement |

All exchanges are server-side. The milestone excludes publishing permission/endpoints, media containers, webhooks, messaging, and comment automation.

## Approved persistence amendment

Paul replaced the proposed OAuth Netlify Blobs design with `@netlify/database` and PostgreSQL. Netlify Blobs may remain in existing Publishing Core, but must not store new security-critical OAuth transactions, credentials, or account ownership.

Required database guarantees include:

- an atomic guarded `pending` to `processing` update returning exactly one winning row;
- immutable transaction tenant and server-selected return destination;
- a unique, non-null account-binding key across tenant credentials;
- one checked-out `db.pool` client for every `BEGIN` / `COMMIT` / `ROLLBACK` sequence, released in `finally`;
- parameterized SQL only;
- atomic account ownership and encrypted credential connection/reconnection;
- no plaintext access-token columns or sensitive row logging.

Migrations live under `netlify/database/migrations/`. No production database may be initialized or mutated during implementation.

## Real database acceptance

Deploy Preview #12 provided an isolated non-production Netlify Database branch with migration `20260917173000_instagram-oauth` applied. On 2026-09-18, the temporary synthetic acceptance harness passed all required checks: migration compatibility, one-time concurrent claim/replay rejection, cross-tenant ownership uniqueness, same-owner reconnect, transactional rollback, and encrypted persistence. After capture of this result, the temporary acceptance function, UI, test, and enable flag were removed.

This evidence closes the real-database acceptance gate. It does not authorize production deployment or live Instagram publishing. Manual identity-only OAuth acceptance remains required.
