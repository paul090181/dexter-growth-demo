CREATE TABLE IF NOT EXISTS growthwise_pilot_events (
  id BIGSERIAL PRIMARY KEY,
  business_id TEXT NOT NULL CHECK (business_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  event_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growthwise_pilot_events_business_idx
  ON growthwise_pilot_events (business_id, created_at DESC);
