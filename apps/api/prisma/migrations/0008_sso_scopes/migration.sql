-- Phase 5A: single sign-on and site-scoped permissions.
--   users            identity source (local, oidc, service) and the IdP subject it maps to
--   sessions         server-side web sessions created from verified OIDC ID tokens (opaque, revocable)
--   user_site_scopes sites a user may change; no rows = every site

ALTER TABLE users
  ADD COLUMN auth_source text NOT NULL DEFAULT 'local',
  ADD COLUMN external_issuer text,
  ADD COLUMN external_subject text,
  ADD COLUMN last_login_at timestamptz,
  ADD CONSTRAINT users_auth_source CHECK (auth_source IN ('local', 'oidc', 'service')),
  ADD CONSTRAINT users_external_identity CHECK ((auth_source = 'oidc') = (external_issuer IS NOT NULL AND external_subject IS NOT NULL));
CREATE UNIQUE INDEX users_external_identity_key ON users (external_issuer, external_subject) WHERE external_subject IS NOT NULL;
UPDATE users SET auth_source = 'service' WHERE role = 'discovery_service';

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     bytea NOT NULL UNIQUE,          -- sha256 of the opaque bearer value; the value itself is never stored
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  id_token_hash  bytea NOT NULL UNIQUE,          -- an ID token can open one session only (replay guard)
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  revoked_at     timestamptz,
  ip             text,
  user_agent     text,
  CONSTRAINT sessions_hash_len CHECK (octet_length(token_hash) = 32 AND octet_length(id_token_hash) = 32),
  CONSTRAINT sessions_window CHECK (expires_at > created_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id, created_at DESC);

CREATE TABLE user_site_scopes (
  user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  site_id  uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  source   text NOT NULL DEFAULT 'manual',
  PRIMARY KEY (user_id, site_id),
  CONSTRAINT user_site_scopes_source CHECK (source IN ('manual', 'oidc'))
);

-- The site an asset lives in, through its rack. NULL for unracked assets.
CREATE FUNCTION asset_site(aid uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT b.site_id FROM assets a
  JOIN racks r ON r.id = a.rack_id JOIN rooms rm ON rm.id = r.room_id JOIN buildings b ON b.id = rm.building_id
  WHERE a.id = aid;
$$;
CREATE FUNCTION rack_site(rid uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT b.site_id FROM racks r JOIN rooms rm ON rm.id = r.room_id JOIN buildings b ON b.id = rm.building_id WHERE r.id = rid;
$$;
