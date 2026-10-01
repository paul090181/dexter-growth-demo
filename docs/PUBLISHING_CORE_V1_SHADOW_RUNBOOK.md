# Publishing Core v1 Shadow Runbook

## Purpose and safety boundary

Publishing Core v1 is a comparison-only system. It normalizes a source record,
prepares channel-specific drafts and jobs, and records the results for review.
It **does not publish externally**. In particular, a channel whose registry
delivery mode is `direct` is still preparation-only in this shadow service.
Do not connect this endpoint to a customer-facing publish control or use it as
evidence that a channel migration is complete.

The existing Auto City and Dexter publishing flows are independent of this
endpoint and remain unchanged.

## Endpoint and authentication

- Method: `POST`
- Path: `/.netlify/functions/publishing-shadow`
- Required header: `X-GrowthWise-Key: <admin key>`
- Content type: `application/json`

The server-side `GROWTHWISE_ADMIN_KEY` environment value supplies the expected
admin key. Never put that key in a request fixture, source control, browser
bundle, screenshot, ticket, or log. Missing or incorrect credentials return
`401`; methods other than `POST` return `405`. Use only a protected operator
tool to call the endpoint.

## Supported pilots

| Business | `business_id` | Vertical | Source field |
| --- | --- | --- | --- |
| Auto City | `auto-city` | `automotive` | `source_record` is a vehicle |
| Dexter's Hats | `dexters-hats` | `retail` | `source_record` is a product |

The business and vertical must be the matching pair shown above. Each request
also requires a role, an ordered media array, and an array of registered channel
IDs. Use `owner_admin` or `manager` for an authorized shadow comparison. The
service rejects cross-business or unsupported business/vertical combinations.

## Automotive example (fake data)

Replace `$SHADOW_BASE_URL` and `$GROWTHWISE_ADMIN_KEY` locally. The values below
are synthetic fixture data and contain no credential or customer record.

```bash
curl --fail-with-body \
  --request POST "$SHADOW_BASE_URL/.netlify/functions/publishing-shadow" \
  --header "Content-Type: application/json" \
  --header "X-GrowthWise-Key: $GROWTHWISE_ADMIN_KEY" \
  --data '{
    "business_id": "auto-city",
    "vertical": "automotive",
    "role": "owner_admin",
    "channels": ["facebook-page", "facebook-marketplace", "website"],
    "source_record": {
      "stock": "DEMO-1042",
      "vin": "1HGCM82633A004352",
      "year": 2021,
      "make": "Honda",
      "model": "Accord",
      "trim": "Sport",
      "mileage": 42100,
      "asking": 24995,
      "status": "available",
      "bodyStyle": "sedan",
      "exteriorColor": "Demo Gray"
    },
    "media": [
      {"id":"demo-front","type":"image","url":"https://example.com/demo-front.jpg","role":"hero","order":0,"approved":true},
      {"id":"demo-rear","type":"image","url":"https://example.com/demo-rear.jpg","role":"gallery","order":1,"approved":true}
    ]
  }'
```

## Retail example (fake data)

```bash
curl --fail-with-body \
  --request POST "$SHADOW_BASE_URL/.netlify/functions/publishing-shadow" \
  --header "Content-Type: application/json" \
  --header "X-GrowthWise-Key: $GROWTHWISE_ADMIN_KEY" \
  --data '{
    "business_id": "dexters-hats",
    "vertical": "retail",
    "role": "manager",
    "channels": ["facebook-marketplace", "instagram", "website"],
    "source_record": {
      "sku": "DEMO-FEDORA-BLK-M",
      "brand": "Dexter’s Hats",
      "name": "Classic Fedora",
      "price": 79,
      "quantity": 8,
      "color": "black",
      "size": "medium",
      "variant": "black-medium",
      "description": "A synthetic product used for shadow comparison."
    },
    "media": [
      {"id":"demo-hat-front","type":"image","url":"https://example.com/demo-hat-front.jpg","role":"hero","order":0,"approved":true}
    ]
  }'
```

## Reading a shadow response

First confirm the response has `mode: "shadow"` and
`live_actions_enabled: false`. Every channel result must also have
`live_sent: false`.

Automation settings determine the simulated job status:

| Automation | Shadow status | Interpretation |
| --- | --- | --- |
| Manual | `Draft` | A draft was prepared for a person; nothing was queued or sent. |
| Review | `Waiting Approval` | The draft would require approval; nothing was sent. |
| Automatic | `Queued` | The policy would permit queueing, but v1 only simulates that state and does not send. |

Facebook Marketplace remains an `assisted` channel and is configured `manual`
for both pilots. Its output is a preparation aid for manual handling, not a
direct Marketplace integration.

`Needs Attention` is the terminal routing decision produced when a failure is a
business-rule or permanent failure, or when a temporary failure reaches the
configured retry limit. Examples include missing channel categories,
permissions or approval, and an exhausted timeout/rate-limit retry budget.
It is a request for operator intervention, never proof of a live attempt.
An isolated preparation exception can appear as `Failed` in an individual
shadow result while successful sibling channels remain available for review.

## Auto City / Dexter comparison checklist

For each pilot, use a known record and compare the shadow response with the
output produced by the existing flow. Do not trigger a live post merely to make
this comparison.

- [ ] Confirm `business_id` matches the pilot and never appears in the other
      pilot's jobs, drafts, or audit records.
- [ ] Compare title and description for meaning, formatting, and completeness.
- [ ] Compare protected facts exactly: VIN/stock/mileage/price/availability for
      Automotive; SKU/quantity/price/availability for Retail.
- [ ] Compare media count, order, hero selection, and approved-only handling.
- [ ] Review each requested channel independently; one failed channel must not
      remove successful sibling results.
- [ ] Confirm Facebook Page and Facebook Marketplace are distinct results and
      Marketplace reports `assisted` delivery.
- [ ] Record capability warnings instead of assuming unsupported fields or
      inventing destination behavior.
- [ ] Confirm the response and every result deny a live send.
- [ ] Compare repeat runs for stable idempotency keys at the same business,
      item, action, channel, and revision.
- [ ] Retain the shadow response and audit references according to normal
      internal data-handling policy; do not copy the admin key with them.

## Local acceptance checks

From the repository root:

```bash
npm run test:publishing
git diff --check
git diff -- automotive-pilot.html index.html netlify/functions/facebook-post.mjs
```

The tests and whitespace check must pass. The protected-file diff must be empty.
No network call to a publishing destination is required by the test suite.

## Rollback

Disable or remove every caller of
`/.netlify/functions/publishing-shadow`; if appropriate, remove/disable the
shadow function itself and its admin key. Do not alter the legacy endpoints to
roll back the shadow service. Auto City and Dexter legacy flows are unchanged,
so they remain on their existing paths. Do not migrate, deploy, or enable live
publishing as part of rollback or this v1 review.
