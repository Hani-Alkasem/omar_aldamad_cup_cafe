-- Phase 4D: machine credentials. A service client (client id + secret) is exchanged at
-- POST /auth/token for a 15-minute JWT, replacing long-lived worker tokens.
-- Only a scrypt hash of the secret is stored.

CREATE TABLE service_clients (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  secret_hash        text NOT NULL,
  secret_prefix      text NOT NULL,          -- first characters, to tell secrets apart in logs and the UI
  secret_rotated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  revoked_at         timestamptz,
  last_used_at       timestamptz,
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT service_clients_hash_shape CHECK (secret_hash ~ '^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$')
);
CREATE UNIQUE INDEX service_clients_name_key ON service_clients (lower(name));
