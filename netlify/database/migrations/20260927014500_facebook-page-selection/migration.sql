ALTER TABLE facebook_oauth_transactions
  ADD COLUMN IF NOT EXISTS selection_hash TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_selection JSONB,
  ADD COLUMN IF NOT EXISTS selection_expires_at TIMESTAMPTZ;

ALTER TABLE facebook_oauth_transactions
  DROP CONSTRAINT IF EXISTS facebook_oauth_transactions_status_check;

ALTER TABLE facebook_oauth_transactions
  ADD CONSTRAINT facebook_oauth_transactions_status_check
  CHECK (status IN (
    'pending','processing','awaiting_selection',
    'consumed_success','consumed_failed','consumed_denied'
  ));

CREATE UNIQUE INDEX IF NOT EXISTS facebook_oauth_transactions_selection_hash_idx
  ON facebook_oauth_transactions (selection_hash)
  WHERE selection_hash IS NOT NULL;
