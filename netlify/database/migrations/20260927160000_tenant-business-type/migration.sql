ALTER TABLE growthwise_tenants
  ADD COLUMN IF NOT EXISTS business_type TEXT NOT NULL DEFAULT 'other';

ALTER TABLE growthwise_tenants
  DROP CONSTRAINT IF EXISTS growthwise_tenants_business_type_check;

ALTER TABLE growthwise_tenants
  ADD CONSTRAINT growthwise_tenants_business_type_check
  CHECK (business_type IN ('retail','bakery_food','auto_dealer','service','other'));
