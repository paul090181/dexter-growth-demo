# GrowthWise Architecture

## Target structure

```text
apps/
  automotive/     # vehicle-specific UI and features
  retail/         # retail-specific UI and features
core/             # shared business platform capabilities
integrations/     # external provider adapters
clients/          # business-specific configuration
```

## Shared Core
Core should eventually own capabilities that can benefit multiple industries:
- authentication and permissions
- business/customer records
- media/photo library
- AI assistant
- publishing/campaign engine
- activity history
- analytics
- automation rules
- audit/safety controls
- exports/imports

## Automotive module
Automotive-only concepts belong here:
- VIN, stock number, mileage
- vehicle inventory
- ADF/XML lead intake
- vehicle marketplaces
- trade-in/acquisition workflows
- service department workflows

## Retail module
Retail-only concepts belong here:
- SKU/variants
- product quantity
- Square/POS synchronization
- product promotions
- reviews and retention
- restock/trend forecasting

## Integrations
Integrations are adapters, not the foundation of GrowthWise. Examples:
- Facebook
- Instagram
- Square
- email/SMS
- dealership lead providers
- websites

If an external service disappears, GrowthWise-owned data and core workflows should remain usable.
