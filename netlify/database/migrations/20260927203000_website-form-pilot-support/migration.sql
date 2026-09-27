DO $$
DECLARE
  constraint_row RECORD;
BEGIN
  FOR constraint_row IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'growthwise_website_forms'::regclass
       AND contype = 'f'
  LOOP
    EXECUTE format(
      'ALTER TABLE growthwise_website_forms DROP CONSTRAINT %I',
      constraint_row.conname
    );
  END LOOP;
END
$$;

COMMENT ON TABLE growthwise_website_forms IS
  'Hosted website-form routing for connector-session tenants, including built-in pilots that may not have a growthwise_tenants row.';
