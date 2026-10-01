CREATE TABLE IF NOT EXISTS facebook_oauth_transactions (
  transaction_key TEXT PRIMARY KEY,
  business_id TEXT NOT NULL CHECK (business_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  status TEXT NOT NULL CHECK (status IN ('pending','processing','consumed_success','consumed_failed','consumed_denied')),
  expires_at TIMESTAMPTZ NOT NULL,
  processing_started_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS facebook_oauth_transactions_business_idx
  ON facebook_oauth_transactions (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS facebook_page_credentials (
  business_id TEXT PRIMARY KEY CHECK (business_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  page_binding_key TEXT NOT NULL UNIQUE,
  encrypted_credential JSONB NOT NULL,
  encryption_key_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','needs_attention','revoked')),
  page_name TEXT,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS facebook_page_credentials_status_idx
  ON facebook_page_credentials (status, updated_at DESC);
