CREATE TABLE retail_lead_automation_settings (
  business_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'shadow'
    CHECK (mode IN ('draft_only','shadow','live_smart')),
  auto_reply_intents JSONB NOT NULL DEFAULT '["availability","price","product_details","size_color","store_visit"]'::jsonb,
  auto_ack_intents JSONB NOT NULL DEFAULT '["shipping","discount","hold","custom_order","complaint"]'::jsonb,
  pause_auto_replies BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE retail_customer_leads
  ADD COLUMN automation_mode TEXT NOT NULL DEFAULT 'draft_only',
  ADD COLUMN automation_class TEXT,
  ADD COLUMN would_auto_send BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN delivery_action TEXT,
  ADD COLUMN automation_reason TEXT;

CREATE INDEX retail_customer_leads_automation_idx
  ON retail_customer_leads (business_id, automation_class, created_at DESC);
