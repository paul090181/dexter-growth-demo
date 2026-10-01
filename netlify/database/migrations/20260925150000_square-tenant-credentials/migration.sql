CREATE TABLE square_credentials (
  business_id TEXT PRIMARY KEY,
  account_binding_key TEXT UNIQUE NOT NULL,
  encrypted_credential JSONB NOT NULL,
  encryption_key_version TEXT NOT NULL,
  environment TEXT NOT NULL
    CHECK (environment IN ('sandbox', 'production')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_attention', 'revoked')),
  token_expires_at TIMESTAMPTZ,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TIMESTAMPTZ
);

CREATE INDEX square_credentials_status_idx
  ON square_credentials (status, updated_at DESC);
