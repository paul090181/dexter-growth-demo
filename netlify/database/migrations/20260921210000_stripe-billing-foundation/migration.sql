CREATE TABLE growthwise_subscriptions (
  business_id TEXT PRIMARY KEY,
  access_source TEXT NOT NULL CHECK (access_source IN ('pilot', 'stripe')),
  plan_key TEXT NOT NULL,
  status TEXT NOT NULL,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  stripe_price_id TEXT,
  current_period_end TIMESTAMPTZ,
  last_event_created_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE stripe_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_created_at TIMESTAMPTZ NOT NULL,
  business_id TEXT,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  result TEXT NOT NULL CHECK (result IN ('processed', 'ignored', 'failed'))
);

CREATE INDEX stripe_webhook_events_business_idx
  ON stripe_webhook_events (business_id, event_created_at DESC);

INSERT INTO growthwise_subscriptions (business_id, access_source, plan_key, status)
VALUES ('dexters-hats', 'pilot', 'founding_monthly', 'pilot')
ON CONFLICT (business_id) DO NOTHING;
