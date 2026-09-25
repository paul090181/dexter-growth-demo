CREATE TABLE retail_customer_leads (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  source TEXT,
  customer_name TEXT,
  customer_contact TEXT,
  message TEXT NOT NULL,
  square_item_id TEXT,
  square_variation_id TEXT,
  product_name TEXT,
  intent TEXT,
  risk_level TEXT,
  decision TEXT,
  suggested_reply TEXT,
  follow_up_action TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','replied','follow-up','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX retail_customer_leads_business_idx
  ON retail_customer_leads (business_id, created_at DESC);

CREATE INDEX retail_customer_leads_status_idx
  ON retail_customer_leads (business_id, status, created_at DESC);
