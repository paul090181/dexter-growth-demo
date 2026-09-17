# Instagram connection runbook

## What exists now

GrowthWise has a reusable, read-only connection-health endpoint and three states: **Not Connected**, **Connected**, and **Needs Attention**. It discovers a professional Instagram account through Facebook Pages managed by the authorized Meta user. Tokens stay in Netlify's server environment and the browser receives only safe identity/status fields.

This sprint does **not** implement the interactive OAuth callback or live publishing. Do not paste a token into the browser, source code, client JSON, support chat, or a URL.

## Paul: connect `growth.wise1` tomorrow

1. In Instagram, confirm `growth.wise1` is a professional **Business** or **Creator** account.
2. In Meta, link it to a Facebook Page controlled by the Meta user who will authorize GrowthWise.
3. In the GrowthWise Meta development app, confirm the approved Instagram Graph/API products, exact Netlify HTTPS OAuth redirect URI, and the least-privilege permissions needed to list managed Pages and read the linked Instagram professional identity. Complete Meta's required tester/app-review steps; do not enable publishing permissions merely for this health milestone.
4. **BLOCKED / DECISION NEEDED:** approve and implement the server-side OAuth start/callback, state/PKCE validation where supported, encrypted tenant credential storage, refresh/revocation handling, and owner membership check. The current admin-key boundary must not be presented as production OAuth.
5. Until that callback exists, a developer may configure the resulting development token only in the `growthwise-dev` Netlify server environment as `GROWTHWISE_DEV_META_ACCESS_TOKEN`. Never expose or commit it. This is a temporary development-health check, not a completed customer connection flow.
6. Call `GET /.netlify/functions/instagram-connection?business_id=growthwise-dev` with the existing `X-GrowthWise-Key` header. Confirm `state` is `Connected` and `account.username` is `growth.wise1`. If **Needs Attention**, verify professional status, Page linkage, Meta-user Page access, permissions, expiry, and app/tester access.
7. Do not create an Instagram media container or publish. Capture only the redacted status response for pilot verification.

## Dexter: connect his account later through the same flow

1. Convert/confirm Dexter's Instagram account as professional and link it to Dexter's Facebook Page.
2. Dexter (or an authorized Meta/Page administrator) signs into the same GrowthWise connection screen as the owner of `dexters-hats`; no code or account ID should change.
3. Review Meta's consent and grant only the approved permissions. GrowthWise's callback stores the token under Dexter's tenant credential record/reference, never in browser storage.
4. Run the same health check for `business_id=dexters-hats` and verify the returned username before enabling any later approved test.
5. Reconnect if the state becomes **Needs Attention**. No live Instagram publishing is permitted until media hosting and a live-test plan receive separate approval.

## Media blocker

Uploaded and cleaned photos currently exist as browser `data:` URLs. These can be previewed locally and uploaded by the unchanged Facebook function, but they are not durable URLs Meta can retrieve for Instagram. Shadow preparation labels them `preview_only`.

**DECISION NEEDED:** choose tenant-isolated durable media storage plus URL exposure/signing, retention, deletion, access control, and moderation policy before live Instagram publishing.

## Safe status contract

The endpoint never returns access tokens, credential environment names, raw Graph errors, Page IDs, or Instagram account IDs. `Connected` returns only the tenant, state, check time, username, and display name. Health checks are read-only.
