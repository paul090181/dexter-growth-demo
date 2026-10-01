DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'growthwise_connector_invitations'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%connectors%'
  LOOP
    EXECUTE format(
      'ALTER TABLE growthwise_connector_invitations DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;

  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'growthwise_connector_sessions'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%connectors%'
  LOOP
    EXECUTE format(
      'ALTER TABLE growthwise_connector_sessions DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END
$$;

ALTER TABLE growthwise_connector_invitations
  ADD CONSTRAINT growthwise_connector_invitations_connectors_allowed_v2
  CHECK (
    cardinality(connectors) BETWEEN 1 AND 4
    AND connectors <@ ARRAY['email', 'facebook', 'instagram', 'website']::TEXT[]
  );

ALTER TABLE growthwise_connector_sessions
  ADD CONSTRAINT growthwise_connector_sessions_connectors_allowed_v2
  CHECK (
    cardinality(connectors) BETWEEN 1 AND 4
    AND connectors <@ ARRAY['email', 'facebook', 'instagram', 'website']::TEXT[]
  );

CREATE TABLE IF NOT EXISTS growthwise_website_forms (
  business_id TEXT PRIMARY KEY REFERENCES growthwise_tenants(business_id) ON DELETE CASCADE,
  form_id TEXT NOT NULL UNIQUE CHECK (form_id ~ '^gwf_[A-Za-z0-9_-]{22}$'),
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS growthwise_website_forms_enabled_idx
  ON growthwise_website_forms (form_id)
  WHERE disabled_at IS NULL;
