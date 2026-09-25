# GrowthWise Meta inbound runbook

This connector feeds Facebook Page Messenger and Instagram professional-account messages into the existing GrowthWise retail inbox. It is inbound-only in this milestone: no webhook event is allowed to send a customer reply.

## Netlify environment

Configure these server-side values:

- `META_APP_SECRET` — Meta app secret used to validate `X-Hub-Signature-256` on webhook POSTs.
- `META_WEBHOOK_VERIFY_TOKEN` — a long random value chosen by GrowthWise and entered into the Meta webhook setup screen.
- `GROWTHWISE_META_ACCOUNT_MAP` — JSON mapping each provider account ID to the GrowthWise business tenant.

The callback URL is `https://<growthwise-site>/.netlify/functions/meta-webhook`.

Never commit tokens, app secrets, verification tokens, or production account maps to the repository.

## Meta setup

For Facebook Messenger, configure the webhook callback, subscribe the Page to the `messages` webhook, and grant the messaging permissions Meta requires. The existing publishing token is not assumed to have Messenger permissions.

For Instagram, Dexter's OAuth now requests `instagram_business_basic`, `instagram_business_content_publish`, and `instagram_business_manage_messages`. Reconnect Instagram once after deploy so the stored credential has the messaging permission, then configure the Instagram messaging webhook subscription.

## Safety

- Webhook verification requires the configured verify token.
- POST payloads require a valid `X-Hub-Signature-256`.
- Provider message IDs are de-duplicated by GrowthWise.
- Echoes and non-message events do not create leads.
- Unmapped provider accounts fail retryably rather than being silently dropped.
- Tenant routing is by explicit account ID, never by customer display name.
- `reply_target` is stored for the later outbound milestone, but `reply_supported` stays false.
- Shadow Mode remains review-only; this connector does not auto-send.
