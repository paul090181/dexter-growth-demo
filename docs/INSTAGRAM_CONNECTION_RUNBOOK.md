# Instagram connection runbook

## What exists now

GrowthWise has a reusable, read-only connection-health endpoint and three states: **Not Connected**, **Connected**, and **Needs Attention**. It verifies the account-scoped token produced by Meta's **Instagram API with Instagram Login** directly against the authenticated professional account. A Facebook Page is not required merely to connect. Tokens and the tenant/account binding stay in Netlify's server environment; the browser receives only safe identity/status fields.

This sprint does **not** implement the interactive OAuth callback or live publishing. Do not paste a token into the browser, source code, client JSON, support chat, or a URL.

## Paul: connect `growth.wise1` tomorrow

1. In Instagram, confirm `growth.wise1` is a professional **Business** or **Creator** account.
2. In the GrowthWise Meta development app, configure **Instagram API with Instagram Login**, the exact Netlify HTTPS OAuth redirect URI, and the current least-privilege `instagram_business_basic` permission for identity/health. Complete Meta's required tester/app-review steps. Do not request `instagram_business_content_publish` for this health milestone and do not enable publishing.
3. **BLOCKED / DECISION NEEDED:** approve and implement the server-side OAuth start/callback, state/PKCE validation where supported, encrypted tenant credential storage, refresh/revocation handling, and owner membership check. The current admin-key boundary must not be presented as production OAuth.
4. Until that callback exists, a developer may configure the resulting account-scoped development token only as `GROWTHWISE_DEV_INSTAGRAM_ACCESS_TOKEN` and its authenticated account ID only as `GROWTHWISE_DEV_INSTAGRAM_ACCOUNT_ID` in the Netlify server environment. Never expose or commit either value. The ID binding prevents a token for another account from being silently accepted. This is a temporary development-health check, not a completed customer connection flow.
5. Call `GET /.netlify/functions/instagram-connection?business_id=growthwise-dev` with the existing `X-GrowthWise-Key` header. Confirm `state` is `Connected` and `account.username` is `growth.wise1`. If **Needs Attention**, verify professional status, Instagram Login permissions, token expiry, app/tester access, and that the stored tenant binding came from the same authorization.
6. Do not create an Instagram media container or publish. Capture only the redacted status response for pilot verification.

## Dexter: connect his account later through the same flow

1. Convert/confirm Dexter's Instagram account as professional; a Facebook Page is not required for this connection flow.
2. Dexter signs into the same GrowthWise Instagram Login connection screen as the owner of `dexters-hats`; no code or hard-coded account ID should change.
3. Review Meta's consent and grant only the approved permissions. GrowthWise's callback stores the token under Dexter's tenant credential record/reference, never in browser storage.
4. Run the same health check for `business_id=dexters-hats` and verify the returned username before enabling any later approved test.
5. Reconnect if the state becomes **Needs Attention**. No live Instagram publishing is permitted until media hosting and a live-test plan receive separate approval.

## Media blocker

Uploaded and cleaned photos currently exist as browser `data:` URLs. These can be previewed locally and uploaded by the unchanged Facebook function, but they are not durable URLs Meta can retrieve for Instagram. Shadow preparation labels them `preview_only`.

**DECISION NEEDED:** choose tenant-isolated durable media storage plus URL exposure/signing, retention, deletion, access control, and moderation policy before live Instagram publishing.

## Safe status contract

The endpoint never returns access tokens, credential environment names, raw Graph errors, or Instagram account IDs. It accepts `Connected` only when `/me` returns one professional account matching the tenant's server-side account binding; a mismatched or ambiguous response fails closed as **Needs Attention**. `Connected` returns only the tenant, state, check time, username, and display name. Health checks are read-only.
