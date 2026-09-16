# GrowthWise Platform v1 — Organization Scaffold

This package is intentionally **non-breaking**. Uploading these folders does not move, rename, or replace the currently deployed Automotive or Dexter files.

## Goal
Turn GrowthWise into one reusable platform with separate industry apps:

- GrowthWise Automotive — Auto City and future dealerships
- GrowthWise Retail — Dexter's Hats and future retailers
- GrowthWise Core — shared capabilities used by every industry
- Integrations — optional connectors such as Facebook, Square, email, websites, etc.
- Client configs — which modules each business is allowed to see/use

## Important rule
Do not create a permanent code fork for every customer. Client differences belong in configuration. Industry differences belong in modules. Shared fixes belong in Core.

## What this package does now
1. Creates the future folder structure.
2. Adds client configuration examples for Auto City and Dexter's Hats.
3. Preserves a snapshot of the validated Automotive v10 code.
4. Preserves the current Dexter retail HTML snapshot available during this migration.
5. Documents the safe migration sequence.

## What it does NOT do yet
- It does not move the live Netlify function paths.
- It does not change the production URLs.
- It does not merge the Automotive and Dexter UIs.
- It does not expose Automotive features to Dexter or Retail features to Auto City.

Read `docs/MIGRATION_PLAN.md` before moving live files.
