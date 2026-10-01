CREATE TABLE IF NOT EXISTS growthwise_pilot_invitations (
  invitation_hash TEXT PRIMARY KEY CHECK (invitation_hash ~ '^[a-f0-9]{64}$'),
  business_id TEXT NOT NULL CHECK (business_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growthwise_pilot_invitations_business_idx
  ON growthwise_pilot_invitations (business_id, created_at DESC);

CREATE TABLE IF NOT EXISTS growthwise_pilot_sessions (
  session_hash TEXT PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  business_id TEXT NOT NULL CHECK (business_id ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growthwise_pilot_sessions_business_idx
  ON growthwise_pilot_sessions (business_id, expires_at DESC);
