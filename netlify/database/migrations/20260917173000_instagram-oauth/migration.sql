CREATE TABLE instagram_oauth_transactions (
  transaction_key text PRIMARY KEY,
  business_id text NOT NULL,
  return_destination_id text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'consumed_success', 'consumed_failed', 'consumed_denied', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processing_started_at timestamptz,
  consumed_at timestamptz
);

CREATE FUNCTION reject_instagram_oauth_transaction_identity_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.transaction_key IS DISTINCT FROM OLD.transaction_key
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.return_destination_id IS DISTINCT FROM OLD.return_destination_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'instagram oauth transaction identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER instagram_oauth_transaction_identity_immutable
BEFORE UPDATE ON instagram_oauth_transactions
FOR EACH ROW EXECUTE FUNCTION reject_instagram_oauth_transaction_identity_change();

CREATE TABLE instagram_credentials (
  business_id text PRIMARY KEY,
  account_binding_key text UNIQUE NOT NULL,
  encrypted_credential jsonb NOT NULL,
  encryption_key_version text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_attention', 'revoked')),
  token_expires_at timestamptz,
  username text,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at timestamptz
);
