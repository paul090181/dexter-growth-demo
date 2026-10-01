CREATE TABLE growthwise_tenants (
  business_id TEXT PRIMARY KEY,
  business_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  access_key_hash TEXT NOT NULL UNIQUE CHECK (access_key_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX growthwise_tenants_contact_email_idx
  ON growthwise_tenants (contact_email);
