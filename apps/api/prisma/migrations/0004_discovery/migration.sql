-- Phase 3: agentless discovery.
--   credentials           vault rows: AES-256-GCM ciphertext only, the key never touches the database
--   discovery_jobs        reshaped: many targets, ordered credentials, VRF, host cap
--   discovery_runs        one row per execution; at most one queued/running run per job; lease for crash recovery
--   discovery_results     one row per responding host: what was found and what the reconciler did
--   assets.system_uuid    SMBIOS UUID, the strongest identity key for reconciliation
-- Custom SQLSTATEs: KB020 credential kind does not fit the job protocol.

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'discovery_service';
ALTER TYPE audit_action ADD VALUE IF NOT EXISTS 'access';

-- 'access' records a read of something sensitive: no before image, an after image saying who/why.
-- Compared as text: a value added by ADD VALUE cannot be used as an enum literal in the same transaction.
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_shape;
ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_shape CHECK (
  (action::text IN ('create', 'access') AND before IS NULL AND after IS NOT NULL)
  OR (action::text = 'update' AND before IS NOT NULL AND after IS NOT NULL)
  OR (action::text = 'delete' AND before IS NOT NULL AND after IS NULL)
);

CREATE TYPE credential_kind AS ENUM ('snmp_v2c', 'snmp_v3', 'ssh_password', 'ssh_key');
CREATE TYPE run_trigger AS ENUM ('manual', 'schedule');
CREATE TYPE discovery_outcome AS ENUM ('created', 'updated', 'unchanged', 'conflict', 'auth_failed', 'error');

-- ─── Credential vault ───────────────────────────────────────────────────────
CREATE TABLE credentials (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  kind               credential_kind NOT NULL,
  username           text,                       -- not secret: SSH user or SNMPv3 security name
  secret_ciphertext  bytea NOT NULL,
  secret_iv          bytea NOT NULL,
  secret_tag         bytea NOT NULL,
  key_id             text NOT NULL,              -- fingerprint of the master key that sealed it (rotation)
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  last_used_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credentials_iv_len CHECK (octet_length(secret_iv) = 12),
  CONSTRAINT credentials_tag_len CHECK (octet_length(secret_tag) = 16),
  CONSTRAINT credentials_username_required CHECK (kind = 'snmp_v2c' OR (username IS NOT NULL AND btrim(username) <> ''))
);
CREATE UNIQUE INDEX credentials_name_key ON credentials (lower(name));
CREATE TRIGGER credentials_set_updated_at BEFORE UPDATE ON credentials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Jobs ───────────────────────────────────────────────────────────────────
-- No job has ever run (Phase 1 shipped the table empty), so reshape rather than migrate data.
DROP TABLE discovery_logs;
ALTER TABLE discovery_jobs
  DROP COLUMN target_cidr,
  DROP COLUMN credential_ref,
  DROP COLUMN discovered_items_count,
  ADD COLUMN targets cidr[] NOT NULL,   -- table is empty; no default (Prisma cannot model one on cidr[])
  ADD COLUMN vrf_id uuid REFERENCES vrfs (id) ON DELETE RESTRICT,
  ADD COLUMN max_hosts integer NOT NULL DEFAULT 1024,
  ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT discovery_jobs_targets_count CHECK (cardinality(targets) BETWEEN 1 AND 64),
  ADD CONSTRAINT discovery_jobs_max_hosts CHECK (max_hosts BETWEEN 1 AND 65536),
  ADD CONSTRAINT discovery_jobs_protocol_supported CHECK (protocol IN ('snmp', 'ssh'));

CREATE TABLE job_credentials (
  job_id         uuid NOT NULL REFERENCES discovery_jobs (id) ON DELETE CASCADE,
  credential_id  uuid NOT NULL REFERENCES credentials (id) ON DELETE RESTRICT,
  position       smallint NOT NULL,
  PRIMARY KEY (job_id, credential_id),
  UNIQUE (job_id, position)
);
CREATE INDEX job_credentials_credential_idx ON job_credentials (credential_id);

-- SNMP jobs take SNMP credentials, SSH jobs take SSH credentials.
CREATE FUNCTION job_credentials_check_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p discovery_protocol;
  k credential_kind;
BEGIN
  SELECT protocol INTO p FROM discovery_jobs WHERE id = NEW.job_id;
  SELECT kind INTO k FROM credentials WHERE id = NEW.credential_id;
  IF (p = 'snmp' AND k NOT IN ('snmp_v2c', 'snmp_v3')) OR (p = 'ssh' AND k NOT IN ('ssh_password', 'ssh_key')) THEN
    RAISE EXCEPTION '% credential cannot be used by a % job', k, p USING ERRCODE = 'KB020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER job_credentials_check_kind BEFORE INSERT OR UPDATE ON job_credentials FOR EACH ROW EXECUTE FUNCTION job_credentials_check_kind();

-- Changing a job's protocol must not strand credentials of the wrong kind on it.
CREATE FUNCTION discovery_jobs_check_protocol_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.protocol IS DISTINCT FROM OLD.protocol AND EXISTS (SELECT 1 FROM job_credentials WHERE job_id = NEW.id) THEN
    RAISE EXCEPTION 'remove credentials before changing the job protocol' USING ERRCODE = 'KB020';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER discovery_jobs_check_protocol_change BEFORE UPDATE OF protocol ON discovery_jobs FOR EACH ROW EXECUTE FUNCTION discovery_jobs_check_protocol_change();

-- ─── Runs ───────────────────────────────────────────────────────────────────
CREATE TABLE discovery_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid NOT NULL REFERENCES discovery_jobs (id) ON DELETE CASCADE,
  trigger           run_trigger NOT NULL,
  requested_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  status            job_status NOT NULL DEFAULT 'queued',
  queued_at         timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  lease_expires_at  timestamptz,
  hosts_total       integer NOT NULL DEFAULT 0,
  hosts_scanned     integer NOT NULL DEFAULT 0,
  hosts_responded   integer NOT NULL DEFAULT 0,
  created_count     integer NOT NULL DEFAULT 0,
  updated_count     integer NOT NULL DEFAULT 0,
  unchanged_count   integer NOT NULL DEFAULT 0,
  conflict_count    integer NOT NULL DEFAULT 0,
  failed_count      integer NOT NULL DEFAULT 0,
  error             text,
  CONSTRAINT discovery_runs_status CHECK (status <> 'never_run'),
  CONSTRAINT discovery_runs_counts CHECK (LEAST(hosts_total, hosts_scanned, hosts_responded, created_count, updated_count, unchanged_count, conflict_count, failed_count) >= 0),
  CONSTRAINT discovery_runs_finished CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL))
);
-- The race-proof "is this job already running?" check.
CREATE UNIQUE INDEX discovery_runs_one_active ON discovery_runs (job_id) WHERE status IN ('queued', 'running');
CREATE INDEX discovery_runs_job_queued_idx ON discovery_runs (job_id, queued_at DESC);
CREATE INDEX discovery_runs_lease_idx ON discovery_runs (lease_expires_at) WHERE status = 'running';

-- Keep the job's summary columns in step with its latest run.
CREATE FUNCTION discovery_runs_sync_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE discovery_jobs SET last_run_status = NEW.status, last_run_at = COALESCE(NEW.started_at, NEW.queued_at) WHERE id = NEW.job_id;
  RETURN NULL;
END $$;
CREATE TRIGGER discovery_runs_sync_job AFTER INSERT OR UPDATE OF status, started_at ON discovery_runs FOR EACH ROW EXECUTE FUNCTION discovery_runs_sync_job();

CREATE TABLE discovery_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES discovery_runs (id) ON DELETE CASCADE,
  ip          inet NOT NULL,
  outcome     discovery_outcome NOT NULL,
  asset_id    uuid REFERENCES assets (id) ON DELETE SET NULL,
  matched_by  text,
  facts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  changes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  message     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_results_matched_by CHECK (matched_by IS NULL OR matched_by IN ('system_uuid', 'serial', 'mac', 'ip')),
  UNIQUE (run_id, ip)
);
CREATE INDEX discovery_results_asset_idx ON discovery_results (asset_id, created_at DESC);

-- ─── Asset identity ─────────────────────────────────────────────────────────
ALTER TABLE assets
  ADD COLUMN system_uuid uuid,
  ADD COLUMN last_discovered_at timestamptz;
CREATE UNIQUE INDEX assets_system_uuid_key ON assets (system_uuid) WHERE system_uuid IS NOT NULL;
-- MAC lookups during reconciliation use network_ports_mac_idx from 0001.
