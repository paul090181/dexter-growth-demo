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
  ADD CONSTRAINT growthwise_connector_invitations_connectors_allowed
  CHECK (
    cardinality(connectors) BETWEEN 1 AND 3
    AND connectors <@ ARRAY['email', 'facebook', 'instagram']::TEXT[]
  );

ALTER TABLE growthwise_connector_sessions
  ADD CONSTRAINT growthwise_connector_sessions_connectors_allowed
  CHECK (
    cardinality(connectors) BETWEEN 1 AND 3
    AND connectors <@ ARRAY['email', 'facebook', 'instagram']::TEXT[]
  );
