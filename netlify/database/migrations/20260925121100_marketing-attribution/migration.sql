CREATE TABLE IF NOT EXISTS growthwise_acquisition_attribution (
  business_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('stripe_promotion_code')),
  campaign_code TEXT NOT NULL,
  stripe_promotion_code_id TEXT NOT NULL,
  stripe_coupon_id TEXT,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  acquisition_plan_key TEXT NOT NULL,
  source_channel TEXT,
  campaign_name TEXT,
  attributed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growthwise_acquisition_attribution_code_idx
  ON growthwise_acquisition_attribution (campaign_code, attributed_at DESC);
