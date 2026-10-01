CREATE TABLE IF NOT EXISTS growthwise_tenant_login_tokens (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  business_id TEXT NOT NULL REFERENCES growthwise_tenants(business_id) ON DELETE CASCADE,
  request_bucket TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (business_id, request_bucket)
);

CREATE INDEX IF NOT EXISTS growthwise_tenant_login_tokens_business_idx
  ON growthwise_tenant_login_tokens (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS growthwise_tenant_sessions (
  session_hash TEXT PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  business_id TEXT NOT NULL REFERENCES growthwise_tenants(business_id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growthwise_tenant_sessions_business_idx
  ON growthwise_tenant_sessions (business_id, expires_at DESC);
