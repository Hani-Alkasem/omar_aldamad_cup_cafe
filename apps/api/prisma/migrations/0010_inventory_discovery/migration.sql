-- Phase 5C: inventory discovery from vCenter, AWS and Azure.
--   Inventory jobs read an API per endpoint (a vCenter URL, an AWS region, an Azure subscription)
--   instead of sweeping CIDRs.
--   asset_external_ids   provider ids (vsphere:<vc>:vm-42, aws:<acct>:<region>:i-…, azure:<vmId>) as identity keys
--   discovery_results    keyed by result_key (external id or IP), so VMs without an IP still get a row
-- Custom SQLSTATE: KB020 also covers the new credential kinds.

ALTER TYPE discovery_protocol ADD VALUE IF NOT EXISTS 'vsphere';
ALTER TYPE discovery_protocol ADD VALUE IF NOT EXISTS 'aws';
ALTER TYPE discovery_protocol ADD VALUE IF NOT EXISTS 'azure';
ALTER TYPE credential_kind ADD VALUE IF NOT EXISTS 'vsphere';
ALTER TYPE credential_kind ADD VALUE IF NOT EXISTS 'aws';
ALTER TYPE credential_kind ADD VALUE IF NOT EXISTS 'azure';

-- Enum literals added above cannot be used in this transaction, so the checks compare text.
ALTER TABLE discovery_jobs
  ADD COLUMN endpoints text[] NOT NULL DEFAULT '{}',
  DROP CONSTRAINT discovery_jobs_targets_count,
  DROP CONSTRAINT discovery_jobs_protocol_supported,
  ADD CONSTRAINT discovery_jobs_protocol_supported CHECK (protocol::text IN ('snmp', 'ssh', 'vsphere', 'aws', 'azure')),
  ADD CONSTRAINT discovery_jobs_scope CHECK (
    CASE WHEN protocol::text IN ('snmp', 'ssh')
         THEN cardinality(targets) BETWEEN 1 AND 64 AND cardinality(endpoints) = 0
         ELSE cardinality(targets) = 0 AND cardinality(endpoints) BETWEEN 1 AND 64 END);

CREATE OR REPLACE FUNCTION job_credentials_check_kind() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  p text;
  k text;
BEGIN
  SELECT protocol::text INTO p FROM discovery_jobs WHERE id = NEW.job_id;
  SELECT kind::text INTO k FROM credentials WHERE id = NEW.credential_id;
  IF NOT ((p = 'snmp' AND k IN ('snmp_v2c', 'snmp_v3')) OR (p = 'ssh' AND k IN ('ssh_password', 'ssh_key')) OR (p IN ('vsphere', 'aws', 'azure') AND k = p)) THEN
    RAISE EXCEPTION '% credential cannot be used by a % job', k, p USING ERRCODE = 'KB020';
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE credentials DROP CONSTRAINT credentials_username_required;
ALTER TABLE credentials ADD CONSTRAINT credentials_username_required
  CHECK (kind::text IN ('snmp_v2c', 'aws', 'azure') OR (username IS NOT NULL AND btrim(username) <> ''));

CREATE TABLE asset_external_ids (
  external_id   text PRIMARY KEY,
  asset_id      uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  source        text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_external_ids_shape CHECK (external_id ~ '^(vsphere|aws|azure):.+')
);
CREATE INDEX asset_external_ids_asset_idx ON asset_external_ids (asset_id);

ALTER TABLE discovery_results ADD COLUMN result_key text;
UPDATE discovery_results SET result_key = host(ip);
ALTER TABLE discovery_results
  ALTER COLUMN result_key SET NOT NULL,
  ALTER COLUMN ip DROP NOT NULL,
  DROP CONSTRAINT discovery_results_run_id_ip_key,
  ADD CONSTRAINT discovery_results_run_key UNIQUE (run_id, result_key),
  DROP CONSTRAINT discovery_results_matched_by,
  ADD CONSTRAINT discovery_results_matched_by CHECK (matched_by IS NULL OR matched_by IN ('external_id', 'system_uuid', 'serial', 'mac', 'ip'));
