# GrowthWise Self-Service Onboarding Design

## Scope

Add the minimum self-service signup and Stripe activation path for a new GrowthWise business in Deploy Preview #14. Reuse the existing Stripe billing foundation and leave Dexter's pilot application and production untouched.

## Flow

1. A public signup page collects business name, contact name, and email.
2. The server creates a unique `business_id` and a cryptographically random tenant access key.
3. Only the key hash is stored. The raw key is returned once to the signup session and is never logged.
4. The new tenant starts locked with no subscription row and no paid access.
5. The tenant key authorizes only requests whose `business_id` matches its stored tenant.
6. Checkout uses the existing server-side Stripe price and fixes `plan_key=founding_monthly` in Checkout and subscription metadata.
7. Only the existing signed Stripe webhook writes subscription state. Access is granted only for `active` or `trialing` server state.
8. A normal paid tenant receives `access_source=stripe`; `dexters-hats` remains `access_source=pilot` and `status=pilot`.

## Security boundaries

- Email is contact data, never authorization.
- Tenant keys do not pass the existing global admin-key authorization and therefore cannot access Dexter's Square, Meta, Instagram, lead, message, inventory, or credential endpoints.
- Admin authorization remains available for the existing configured pilot tenants.
- Tenant checkout and subscription-status requests require both the tenant key and its exact server-stored `business_id`.
- Stripe events may mutate only an already registered tenant or an existing subscription tenant. Arbitrary event metadata must fail closed.
- Public status responses never include Stripe identifiers, contact data, access-key hashes, integrations, credentials, or other tenant data.
- No Customer Portal, recovery flow, production migration, or unrelated UX change is included.

## Persistence

Create `growthwise_tenants` with the minimum contact fields and a unique access-key hash. Keep subscription lifecycle state in the existing `growthwise_subscriptions` table and event audit state in `stripe_webhook_events`.

## Acceptance

Automated tests must cover unique identity/key creation, hash-only persistence, wrong-tenant denial, pre-payment locking, fixed checkout metadata/price, webhook-only activation, normal Stripe access, Dexter pilot preservation, and isolation from admin-only data endpoints. The preview acceptance test must create one new tenant and complete one $49 Stripe sandbox subscription without touching production.
