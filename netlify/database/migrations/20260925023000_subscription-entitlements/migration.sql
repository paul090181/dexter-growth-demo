ALTER TABLE growthwise_subscriptions
  ADD COLUMN IF NOT EXISTS plan_started_at TIMESTAMPTZ;

UPDATE growthwise_subscriptions
   SET plan_started_at = COALESCE(plan_started_at, created_at)
 WHERE plan_started_at IS NULL;

ALTER TABLE growthwise_subscriptions
  ALTER COLUMN plan_started_at SET DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE growthwise_subscriptions
  ALTER COLUMN plan_started_at SET NOT NULL;
