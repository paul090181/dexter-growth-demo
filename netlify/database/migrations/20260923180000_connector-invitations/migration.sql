CREATE TABLE growthwise_connector_invitations (
  invitation_hash TEXT PRIMARY KEY CHECK (invitation_hash ~ '^[a-f0-9]{64}$'),
  business_id TEXT NOT NULL,
  connectors TEXT[] NOT NULL CHECK (
    cardinality(connectors) BETWEEN 1 AND 2
    AND connectors <@ ARRAY['facebook', 'instagram']::TEXT[]
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (revoked_at IS NULL OR used_at IS NULL)
);

CREATE TABLE growthwise_connector_sessions (
  session_hash TEXT PRIMARY KEY CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  business_id TEXT NOT NULL,
  connectors TEXT[] NOT NULL CHECK (
    cardinality(connectors) BETWEEN 1 AND 2
    AND connectors <@ ARRAY['facebook', 'instagram']::TEXT[]
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX growthwise_connector_invitations_business_idx
  ON growthwise_connector_invitations (business_id, expires_at);
CREATE INDEX growthwise_connector_sessions_business_idx
  ON growthwise_connector_sessions (business_id, expires_at);

CREATE FUNCTION prevent_connector_identity_change() RETURNS trigger AS $$
BEGIN
  IF NEW.invitation_hash IS DISTINCT FROM OLD.invitation_hash
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.connectors IS DISTINCT FROM OLD.connectors
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'connector invitation identity is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER connector_invitation_identity_immutable
  BEFORE UPDATE ON growthwise_connector_invitations
  FOR EACH ROW EXECUTE FUNCTION prevent_connector_identity_change();
