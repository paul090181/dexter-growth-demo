CREATE TABLE microsoft_mail_subscriptions (
  business_id text PRIMARY KEY,
  subscription_id text UNIQUE NOT NULL,
  client_state_hash text NOT NULL
    CHECK (client_state_hash ~ '^[a-f0-9]{64}$'),
  resource text NOT NULL
    CHECK (resource = 'me/mailFolders(''Inbox'')/messages'),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_attention', 'deleted')),
  expires_at timestamptz NOT NULL,
  last_notification_at timestamptz,
  last_renewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX microsoft_mail_subscriptions_renew_idx
  ON microsoft_mail_subscriptions (status, expires_at);
