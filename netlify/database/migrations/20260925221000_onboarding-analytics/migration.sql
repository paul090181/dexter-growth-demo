CREATE TABLE IF NOT EXISTS growthwise_onboarding_events (
  id BIGSERIAL PRIMARY KEY,
  business_id TEXT NOT NULL,
  event_name TEXT NOT NULL CHECK (
    event_name IN (
      'workspace_created',
      'checkout_started',
      'checkout_completed',
      'workspace_opened',
      'square_connect_started',
      'square_connected',
      'business_pulse_loaded',
      'ai_workflow_used'
    )
  ),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  occurred_on DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, event_name, occurred_on)
);

CREATE INDEX IF NOT EXISTS growthwise_onboarding_events_business_time_idx
  ON growthwise_onboarding_events (business_id, occurred_at ASC);

CREATE INDEX IF NOT EXISTS growthwise_onboarding_events_name_time_idx
  ON growthwise_onboarding_events (event_name, occurred_at ASC);
