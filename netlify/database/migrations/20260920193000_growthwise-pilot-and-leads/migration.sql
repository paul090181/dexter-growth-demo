CREATE TABLE growthwise_interest_leads (
  id TEXT PRIMARY KEY,
  referral_code TEXT,
  referrer_business TEXT,
  name TEXT NOT NULL,
  business_name TEXT NOT NULL,
  contact TEXT NOT NULL,
  industry TEXT,
  message TEXT,
  source_path TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new','contacted','qualified','pilot','customer','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX growthwise_interest_leads_created_idx
  ON growthwise_interest_leads (created_at DESC);

CREATE INDEX growthwise_interest_leads_referral_idx
  ON growthwise_interest_leads (referral_code, created_at DESC);

CREATE TABLE growthwise_pilot_feedback (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  result TEXT NOT NULL
    CHECK (result IN ('worked','needs-improvement')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX growthwise_pilot_feedback_business_idx
  ON growthwise_pilot_feedback (business_id, created_at DESC);
