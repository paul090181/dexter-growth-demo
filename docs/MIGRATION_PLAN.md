# Safe Migration Plan

## Phase 0 — Freeze known-good baselines
Before reorganizing live paths:
1. Keep the current Automotive v10 deployment working.
2. Create a Git tag/release named `automotive-v10-stable` if possible.
3. Keep Dexter's current production/test deployment working.
4. Create a Git tag/release named `retail-dexters-baseline` if possible.

The `snapshots/` folder in this package is an additional recovery reference, not a replacement for Git history.

## Phase 1 — Add structure without moving production
Upload this package on a new branch named `platform-v1` created from the current Automotive branch.

This commit should only ADD folders/files. Do not delete or rename the current root Automotive page or Netlify functions.

Expected result: current Automotive deployment behaves exactly as before.

## Phase 2 — Establish shared Core interfaces
The first shared feature should be the GrowthWise Publishing Bridge. Define one generic publishing record and then add adapters for Automotive and Retail.

Example generic record:
- business_id
- item_type
- item_id
- title
- description
- price
- media[]
- destination channel
- status / approval

Automotive can add VIN/mileage/stock fields. Retail can add SKU/quantity/variant fields without changing the common publishing engine.

## Phase 3 — Move each app behind its own entry point
Once shared code is stable:
- `apps/automotive/` becomes the Automotive app entry point.
- `apps/retail/` becomes the Retail app entry point.

Do this one app at a time and regression-test before changing Netlify routing.

## Phase 4 — Separate deployments, same repository
Create separate Netlify sites/deploy contexts that point at the appropriate app while using the same repo and shared code.

Auto City sees only Automotive modules. Dexter sees only Retail modules.

## Phase 5 — Add future clients by configuration
New clients should usually require:
1. a client config
2. credentials for optional integrations
3. branding/settings

They should NOT require cloning the codebase.
