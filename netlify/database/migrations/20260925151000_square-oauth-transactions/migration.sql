CREATE TABLE square_oauth_transactions (
  transaction_key TEXT PRIMARY KEY,
  business_id TEXT NOT NULL,
  environment TEXT NOT NULL
    CHECK (environment IN ('sandbox', 'production')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'processing', 'consumed_success',
      'consumed_failed', 'consumed_denied', 'expired'
    )),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processing_started_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX square_oauth_transactions_business_idx
  ON square_oauth_transactions (business_id, expires_at);

CREATE FUNCTION reject_square_oauth_transaction_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.transaction_key IS DISTINCT FROM OLD.transaction_key
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'square oauth transaction identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER square_oauth_transaction_identity_immutable
BEFORE UPDATE ON square_oauth_transactions
FOR EACH ROW EXECUTE FUNCTION reject_square_oauth_transaction_identity_change();
