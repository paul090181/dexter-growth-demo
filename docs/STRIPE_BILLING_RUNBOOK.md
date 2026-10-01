# Stripe Billing Preview Runbook

This runbook is for GrowthWise's Stripe sandbox and Netlify Deploy Preview only. Do not add live Stripe credentials or configure a production webhook while following it.

## Preview configuration

Preview site:

`https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app`

Webhook endpoint:

`https://deploy-preview-14--euphonious-beijinho-db4b4d.netlify.app/.netlify/functions/stripe-webhook`

Configure these Netlify variables for **Deploy Previews only**:

| Variable | Secret | Scope | Value |
| --- | --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | Functions + Runtime | Rotated Stripe sandbox secret key |
| `STRIPE_PRICE_ID` | No | Functions + Runtime | Founding Plan sandbox Price ID |
| `STRIPE_WEBHOOK_SECRET` | Yes | Functions + Runtime | Signing secret from the preview webhook destination |
| `GROWTHWISE_PUBLIC_ORIGIN` | No | Functions + Runtime | Exact preview origin shown above, with no trailing slash |

Never place a Stripe secret in source control, screenshots, issue comments, or chat.

## Deploy and webhook order

1. Run `npm ci`, `npm run test:billing`, and `npm run test:all` locally.
2. Push the reviewed branch so Netlify rebuilds Deploy Preview #14. Confirm the database migration completed and the functions are present.
3. Confirm `GROWTHWISE_PUBLIC_ORIGIN`, `STRIPE_SECRET_KEY`, and `STRIPE_PRICE_ID` are set for Deploy Previews only.
4. In Stripe sandbox, create a webhook destination using the exact endpoint above.
5. Subscribe that destination to only these six events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.paid`
   - `invoice.payment_failed`
6. Copy the destination's signing secret directly into Netlify as `STRIPE_WEBHOOK_SECRET`. Mark it secret and Deploy Previews only.
7. Trigger a new deploy of Preview #14 so every function receives the complete environment.

## Sandbox acceptance test

1. Open Preview #14 and unlock GrowthWise with the existing GrowthWise access key.
2. Confirm the Founding Plan card reports the server status and shows `$49/month` with `Sandbox checkout`.
3. Select **Open sandbox checkout**.
4. Confirm the browser goes to an HTTPS `checkout.stripe.com` page showing the configured $49 monthly sandbox plan.
5. Complete Checkout with Stripe's test card `4242 4242 4242 4242`, any future expiry date, any CVC, and any valid postal code.
6. On return, confirm the page says it is checking the server. The return query string must not itself grant or display paid access.
7. Refresh status and inspect the database row for the tenant. For a normal Stripe tenant, expect the lifecycle status to become `active` after the signed subscription event. For `dexters-hats`, expect `access_source=pilot` and `status=pilot` to remain authoritative during the pilot even though webhook events are recorded.

## Webhook resilience checks

### Replay

In Stripe sandbox, resend one successfully processed event. Expect HTTP 200 and no duplicate state transition. The event ID should remain unique in `stripe_webhook_events`.

### Failed payment

Use Stripe sandbox tooling to produce `invoice.payment_failed` for a test subscription already bound to the tenant. Expect HTTP 200 and `past_due` for a normal Stripe tenant. Dexter's pilot state must remain `pilot`.

### Cancellation

Cancel the sandbox subscription and confirm `customer.subscription.deleted` is delivered. Expect `canceled` for a normal Stripe tenant. Dexter's pilot state must remain `pilot`.

### Invalid signature

Send a request without a valid Stripe signature. Expect HTTP 400 and no event or subscription mutation.

## Troubleshooting

- HTTP 503 from Checkout: verify all three Checkout inputs exist in the Deploy Preview context: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, and the exact HTTPS `GROWTHWISE_PUBLIC_ORIGIN`.
- HTTP 503 from the webhook: verify `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are available to Deploy Preview functions, then rebuild.
- HTTP 400 from Stripe delivery: verify the webhook signing secret belongs to this exact sandbox destination and was copied without whitespace.
- HTTP 500 from Stripe delivery: inspect the safe structured function log by event ID/type, correct the durable tenant mapping or database problem, and let Stripe retry.
- Checkout succeeds but status does not change: check delivery order and metadata. The Checkout session and subscription must carry `business_id` and `plan_key`; invoice events require an existing durable Stripe customer/subscription binding.

## Rollback

1. Disable the sandbox webhook destination in Stripe.
2. Remove `STRIPE_WEBHOOK_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, and `GROWTHWISE_PUBLIC_ORIGIN` from the Netlify Deploy Preview context only.
3. Rebuild Preview #14.
4. Verify Checkout and webhook endpoints fail closed with HTTP 503.

Do not delete event history or subscription rows during rollback. They are audit and recovery data. Do not change production environment variables or production webhook destinations.
