# GrowthWise Versioning

## Branches
Use branches for development work, not permanent customer copies.

Recommended:
- `main` — stable GrowthWise platform
- `develop` — integration branch when needed
- `feature/<name>` — temporary feature work

Examples:
- `feature/publishing-bridge`
- `feature/marketplace-bridge`
- `feature/retail-reviews`
- `feature/automotive-leads`

Avoid permanent branches such as `auto-city-version`, `dexter-version`, `client-3-version`.

## Tags / releases
Use Git tags to preserve known-good releases.

Recommended tags:
- `automotive-v10-stable` — current validated Automotive lead-gateway baseline
- `retail-dexters-baseline` — Dexter baseline at the start of platform migration
- future shared releases: `platform-v1.0.0`, `platform-v1.1.0`, etc.

## App versions vs platform versions
A platform release can contain different module versions. Example:

```text
GrowthWise Platform 1.2.0
  Core 1.2
  Automotive 1.4
  Retail 1.1
```

Customers should not choose versions manually. Their client config controls which modules appear.
