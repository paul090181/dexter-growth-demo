ALTER TABLE retail_customer_leads
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (source_type IN ('instagram','facebook','email','website','sms','phone','manual','other')),
  ADD COLUMN source_account TEXT,
  ADD COLUMN external_thread_id TEXT,
  ADD COLUMN external_message_id TEXT,
  ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound'
    CHECK (direction IN ('inbound','outbound')),
  ADD COLUMN received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN unread BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN reply_supported BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN reply_target TEXT,
  ADD COLUMN source_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX retail_customer_leads_external_message_idx
  ON retail_customer_leads (business_id, source_type, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE INDEX retail_customer_leads_source_idx
  ON retail_customer_leads (business_id, source_type, received_at DESC);

CREATE INDEX retail_customer_leads_unread_idx
  ON retail_customer_leads (business_id, unread, received_at DESC);

CREATE TABLE growthwise_lead_sources (
  business_id TEXT NOT NULL,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('instagram','facebook','email','website','sms','phone','manual','other')),
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected','ready','connected','needs_attention')),
  inbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  outbound_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_event_at TIMESTAMPTZ,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (business_id, source_type)
);

CREATE INDEX growthwise_lead_sources_status_idx
  ON growthwise_lead_sources (business_id, status);
