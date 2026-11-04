-- ITAM / CMDB / DCIM core schema. Hand-written; this file is the source of truth.
-- prisma/schema.prisma is introspected from the database (`prisma db pull`).
--
-- Custom SQLSTATEs raised by triggers (mapped to HTTP errors by the API):
--   KB001 rack placement out of range     KB002 rack placement invalid
--   KB003 CIDR has host bits set          KB004 IP outside its subnet
--   KB005 IP is network/broadcast         KB006 audit log is immutable

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── Enums ──────────────────────────────────────────────────────────────────
CREATE TYPE asset_type AS ENUM (
  'physical_server', 'blade_server', 'virtual_machine', 'switch', 'router', 'firewall',
  'load_balancer', 'storage_array', 'patch_panel', 'pdu', 'ups', 'workstation', 'mobile_device', 'other'
);
CREATE TYPE asset_status AS ENUM ('planned', 'in_stock', 'active', 'maintenance', 'retired', 'disposed');
CREATE TYPE rack_face AS ENUM ('front', 'rear');
CREATE TYPE mount_depth AS ENUM ('full', 'half', 'zero_u');
CREATE TYPE ip_status AS ENUM ('available', 'assigned', 'reserved', 'dhcp');
CREATE TYPE relationship_type AS ENUM ('runs_on', 'connects_to', 'depends_on', 'powered_by');
CREATE TYPE audit_action AS ENUM ('create', 'update', 'delete');
CREATE TYPE user_role AS ENUM ('admin', 'dc_technician', 'network_engineer', 'auditor');
CREATE TYPE discovery_protocol AS ENUM ('snmp', 'ssh', 'wmi', 'api', 'nmap');
CREATE TYPE job_status AS ENUM ('never_run', 'queued', 'running', 'succeeded', 'failed', 'partial');
CREATE TYPE cable_media AS ENUM ('cat5e', 'cat6', 'cat6a', 'fiber_om3', 'fiber_om4', 'fiber_os2', 'dac', 'aoc', 'power');

-- ─── Shared helpers ─────────────────────────────────────────────────────────
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- ─── Users ──────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  display_name  text NOT NULL,
  role          user_role NOT NULL DEFAULT 'auditor',
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- ─── Location hierarchy: site → building → room → row → rack ────────────────
CREATE TABLE sites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  address     text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE buildings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE RESTRICT,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, name)
);

CREATE TABLE rooms (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id  uuid NOT NULL REFERENCES buildings (id) ON DELETE RESTRICT,
  name         text NOT NULL,
  floor        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (building_id, name)
);

CREATE TABLE rack_rows (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid NOT NULL REFERENCES rooms (id) ON DELETE RESTRICT,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, name)
);

CREATE TABLE racks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  row_id           uuid REFERENCES rack_rows (id) ON DELETE RESTRICT,
  room_id          uuid NOT NULL REFERENCES rooms (id) ON DELETE RESTRICT,
  name             text NOT NULL,
  height_u         smallint NOT NULL DEFAULT 42,
  numbering_desc   boolean NOT NULL DEFAULT false,   -- true when U1 is at the top
  max_power_w      integer,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT racks_height_range CHECK (height_u BETWEEN 1 AND 60),
  CONSTRAINT racks_max_power_positive CHECK (max_power_w IS NULL OR max_power_w > 0),
  UNIQUE (room_id, name)
);
CREATE INDEX racks_row_id_idx ON racks (row_id);

-- ─── Hardware catalogue ─────────────────────────────────────────────────────
CREATE TABLE manufacturers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX manufacturers_name_key ON manufacturers (lower(name));

CREATE TABLE hardware_models (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manufacturer_id      uuid NOT NULL REFERENCES manufacturers (id) ON DELETE RESTRICT,
  model_number         text NOT NULL,
  size_u               smallint NOT NULL DEFAULT 1,
  depth                mount_depth NOT NULL DEFAULT 'full',
  power_ports_count    smallint NOT NULL DEFAULT 0,
  network_ports_count  smallint NOT NULL DEFAULT 0,
  typical_power_w      integer,
  front_image_url      text,
  rear_image_url       text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hardware_models_size_range CHECK (size_u BETWEEN 0 AND 60),
  CONSTRAINT hardware_models_ports_nonneg CHECK (power_ports_count >= 0 AND network_ports_count >= 0),
  UNIQUE (manufacturer_id, model_number)
);

-- ─── Assets (polymorphic CIs) ───────────────────────────────────────────────
CREATE TABLE assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  asset_tag       text,
  serial_number   text,
  type            asset_type NOT NULL,
  status          asset_status NOT NULL DEFAULT 'active',
  model_id        uuid REFERENCES hardware_models (id) ON DELETE SET NULL,
  parent_id       uuid REFERENCES assets (id) ON DELETE SET NULL,   -- blade → chassis, VM → host
  rack_id         uuid REFERENCES racks (id) ON DELETE RESTRICT,
  start_u         smallint,
  size_u          smallint NOT NULL DEFAULT 1,
  face            rack_face,
  depth           mount_depth NOT NULL DEFAULT 'full',
  power_draw_w    integer,
  custom_fields   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assets_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT assets_size_range CHECK (size_u BETWEEN 1 AND 60),
  CONSTRAINT assets_start_positive CHECK (start_u IS NULL OR start_u >= 1),
  CONSTRAINT assets_custom_fields_object CHECK (jsonb_typeof(custom_fields) = 'object'),
  CONSTRAINT assets_power_nonneg CHECK (power_draw_w IS NULL OR power_draw_w >= 0),
  CONSTRAINT assets_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  -- Placement is all-or-nothing: unracked assets carry no U/face; racked ones carry both,
  -- except zero-U (vertical PDUs) which mount in the side channel and carry neither.
  CONSTRAINT assets_placement_consistent CHECK (
    (rack_id IS NULL AND start_u IS NULL AND face IS NULL)
    OR (rack_id IS NOT NULL AND depth = 'zero_u' AND start_u IS NULL)
    OR (rack_id IS NOT NULL AND depth <> 'zero_u' AND start_u IS NOT NULL AND face IS NOT NULL)
  )
);
CREATE UNIQUE INDEX assets_asset_tag_key ON assets (asset_tag) WHERE asset_tag IS NOT NULL;
CREATE UNIQUE INDEX assets_serial_number_key ON assets (serial_number) WHERE serial_number IS NOT NULL;
CREATE INDEX assets_rack_id_idx ON assets (rack_id) WHERE rack_id IS NOT NULL;
CREATE INDEX assets_model_id_idx ON assets (model_id);
CREATE INDEX assets_parent_id_idx ON assets (parent_id);
CREATE INDEX assets_type_status_idx ON assets (type, status);
CREATE INDEX assets_name_idx ON assets (lower(name));
CREATE INDEX assets_custom_fields_gin ON assets USING gin (custom_fields jsonb_path_ops);

-- One row per rack face a device physically blocks. The EXCLUDE constraint is the
-- race-proof guarantee that no two devices share a U on the same face.
CREATE TABLE asset_rack_occupancy (
  asset_id  uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  rack_id   uuid NOT NULL REFERENCES racks (id) ON DELETE CASCADE,
  face      rack_face NOT NULL,
  u_range   int4range NOT NULL,
  PRIMARY KEY (asset_id, face),
  CONSTRAINT asset_rack_occupancy_no_overlap
    EXCLUDE USING gist (rack_id WITH =, face WITH =, u_range WITH &&)
);

CREATE FUNCTION sync_asset_rack_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rack_height smallint;
  top_u       integer;
BEGIN
  DELETE FROM asset_rack_occupancy WHERE asset_id = NEW.id;

  IF NEW.rack_id IS NULL OR NEW.depth = 'zero_u' THEN
    RETURN NEW;
  END IF;

  SELECT height_u INTO rack_height FROM racks WHERE id = NEW.rack_id;
  top_u := NEW.start_u + NEW.size_u - 1;
  IF top_u > rack_height THEN
    RAISE EXCEPTION 'device % (U% to U%) exceeds rack height of %U', NEW.name, NEW.start_u, top_u, rack_height
      USING ERRCODE = 'KB001', HINT = format('max start U for size %s is %s', NEW.size_u, rack_height - NEW.size_u + 1);
  END IF;

  INSERT INTO asset_rack_occupancy (asset_id, rack_id, face, u_range)
  SELECT NEW.id, NEW.rack_id, f, int4range(NEW.start_u, NEW.start_u + NEW.size_u)
  FROM unnest(CASE WHEN NEW.depth = 'full' THEN ARRAY['front', 'rear']::rack_face[] ELSE ARRAY[NEW.face] END) AS f;

  RETURN NEW;
END $$;

CREATE TRIGGER assets_sync_rack_occupancy
  AFTER INSERT OR UPDATE OF rack_id, start_u, size_u, face, depth ON assets
  FOR EACH ROW EXECUTE FUNCTION sync_asset_rack_occupancy();
CREATE TRIGGER assets_set_updated_at BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Components (CPU, RAM, disks, GPUs) live under their asset.
CREATE TABLE asset_components (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  kind           text NOT NULL,          -- cpu | memory | disk | gpu | nic | psu | firmware
  slot           text,
  manufacturer   text,
  model          text,
  serial_number  text,
  capacity       numeric,                -- cores, GB, W … per kind
  attributes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_components_kind CHECK (kind IN ('cpu', 'memory', 'disk', 'gpu', 'nic', 'psu', 'firmware'))
);
CREATE INDEX asset_components_asset_id_idx ON asset_components (asset_id);

-- ─── Network: VRFs, VLANs, ports, cables ────────────────────────────────────
CREATE TABLE vrfs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  rd          text UNIQUE,                     -- route distinguisher, e.g. 65000:100
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vlans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id     uuid REFERENCES sites (id) ON DELETE RESTRICT,
  vid         smallint NOT NULL,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vlans_vid_range CHECK (vid BETWEEN 1 AND 4094)
);
CREATE UNIQUE INDEX vlans_site_vid_key ON vlans (COALESCE(site_id, '00000000-0000-0000-0000-000000000000'::uuid), vid);

CREATE TABLE network_ports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id     uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  port_name    text NOT NULL,
  mac_address  macaddr,
  speed_mbps   integer,
  vlan_id      uuid REFERENCES vlans (id) ON DELETE SET NULL,
  is_uplink    boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT network_ports_speed_positive CHECK (speed_mbps IS NULL OR speed_mbps > 0),
  UNIQUE (asset_id, port_name)
);
CREATE INDEX network_ports_mac_idx ON network_ports (mac_address) WHERE mac_address IS NOT NULL;
CREATE INDEX network_ports_vlan_idx ON network_ports (vlan_id);

-- A cable joins exactly two distinct ports; each port carries at most one cable.
CREATE TABLE cables (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  a_port_id   uuid NOT NULL REFERENCES network_ports (id) ON DELETE CASCADE,
  b_port_id   uuid NOT NULL REFERENCES network_ports (id) ON DELETE CASCADE,
  media       cable_media NOT NULL DEFAULT 'cat6',
  label       text,
  length_m    numeric(6, 2),
  circuit_id  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cables_distinct_ends CHECK (a_port_id <> b_port_id),
  CONSTRAINT cables_length_positive CHECK (length_m IS NULL OR length_m > 0)
);
CREATE UNIQUE INDEX cables_a_port_key ON cables (a_port_id);
CREATE UNIQUE INDEX cables_b_port_key ON cables (b_port_id);

-- A port may not appear as the A end of one cable and the B end of another.
CREATE FUNCTION cables_port_single_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cables c
    WHERE c.id <> NEW.id
      AND (c.a_port_id IN (NEW.a_port_id, NEW.b_port_id) OR c.b_port_id IN (NEW.a_port_id, NEW.b_port_id))
  ) THEN
    RAISE EXCEPTION 'port already cabled' USING ERRCODE = '23505', CONSTRAINT = 'cables_port_single_use';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cables_port_single_use BEFORE INSERT OR UPDATE ON cables FOR EACH ROW EXECUTE FUNCTION cables_port_single_use();

-- ─── IPAM ───────────────────────────────────────────────────────────────────
CREATE TABLE subnets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cidr         cidr NOT NULL,
  name         text,
  description  text,
  vrf_id       uuid REFERENCES vrfs (id) ON DELETE RESTRICT,
  vlan_id      uuid REFERENCES vlans (id) ON DELETE SET NULL,
  parent_id    uuid REFERENCES subnets (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subnets_no_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
-- CIDR blocks are either disjoint or nested, so "overlap" means an exact duplicate per VRF.
CREATE UNIQUE INDEX subnets_vrf_cidr_key ON subnets (COALESCE(vrf_id, '00000000-0000-0000-0000-000000000000'::uuid), cidr);
CREATE INDEX subnets_cidr_gist ON subnets USING gist (cidr inet_ops);
CREATE INDEX subnets_parent_id_idx ON subnets (parent_id);
CREATE INDEX subnets_vlan_id_idx ON subnets (vlan_id);

-- Resolve the parent as the smallest containing subnet in the same VRF.
CREATE FUNCTION subnets_resolve_parent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT s.id INTO NEW.parent_id
  FROM subnets s
  WHERE s.id <> NEW.id
    AND s.vrf_id IS NOT DISTINCT FROM NEW.vrf_id
    AND s.cidr >> NEW.cidr
  ORDER BY masklen(s.cidr) DESC
  LIMIT 1;
  RETURN NEW;
END $$;
CREATE TRIGGER subnets_resolve_parent
  BEFORE INSERT OR UPDATE OF cidr, vrf_id ON subnets
  FOR EACH ROW EXECUTE FUNCTION subnets_resolve_parent();

-- When a supernet appears between a parent and its children, adopt those children.
CREATE FUNCTION subnets_adopt_children() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE subnets s
  SET parent_id = NEW.id
  WHERE s.id <> NEW.id
    AND s.vrf_id IS NOT DISTINCT FROM NEW.vrf_id
    AND s.cidr << NEW.cidr
    AND s.parent_id IS NOT DISTINCT FROM NEW.parent_id;
  RETURN NULL;
END $$;
CREATE TRIGGER subnets_adopt_children AFTER INSERT ON subnets FOR EACH ROW EXECUTE FUNCTION subnets_adopt_children();
CREATE TRIGGER subnets_set_updated_at BEFORE UPDATE ON subnets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ip_addresses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ip            inet NOT NULL,
  subnet_id     uuid NOT NULL REFERENCES subnets (id) ON DELETE RESTRICT,
  vrf_id        uuid REFERENCES vrfs (id) ON DELETE RESTRICT,   -- copied from the subnet
  asset_id      uuid REFERENCES assets (id) ON DELETE SET NULL,
  port_id       uuid REFERENCES network_ports (id) ON DELETE SET NULL,
  status        ip_status NOT NULL DEFAULT 'assigned',
  dns_name      text,
  description   text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ip_addresses_vrf_ip_key ON ip_addresses (COALESCE(vrf_id, '00000000-0000-0000-0000-000000000000'::uuid), ip);
CREATE INDEX ip_addresses_subnet_ip_idx ON ip_addresses (subnet_id, ip);
CREATE INDEX ip_addresses_ip_gist ON ip_addresses USING gist (ip inet_ops);
CREATE INDEX ip_addresses_asset_id_idx ON ip_addresses (asset_id);
CREATE INDEX ip_addresses_port_id_idx ON ip_addresses (port_id);

-- Normalise the address to a host prefix, keep it inside its subnet, and inherit the VRF.
CREATE FUNCTION ip_addresses_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  net  cidr;
  vrf  uuid;
BEGIN
  SELECT cidr, vrf_id INTO net, vrf FROM subnets WHERE id = NEW.subnet_id;
  NEW.ip := set_masklen(NEW.ip, CASE family(NEW.ip) WHEN 4 THEN 32 ELSE 128 END);
  NEW.vrf_id := vrf;

  IF family(NEW.ip) <> family(net) OR NOT (NEW.ip <<= net) THEN
    RAISE EXCEPTION 'address % is outside subnet %', host(NEW.ip), net USING ERRCODE = 'KB004';
  END IF;

  IF family(net) = 4 AND masklen(net) < 31
     AND (host(NEW.ip) = host(network(net)) OR host(NEW.ip) = host(broadcast(net))) THEN
    RAISE EXCEPTION 'address % is the network or broadcast address of %', host(NEW.ip), net USING ERRCODE = 'KB005';
  END IF;

  RETURN NEW;
END $$;
CREATE TRIGGER ip_addresses_validate
  BEFORE INSERT OR UPDATE OF ip, subnet_id ON ip_addresses
  FOR EACH ROW EXECUTE FUNCTION ip_addresses_validate();
CREATE TRIGGER ip_addresses_set_updated_at BEFORE UPDATE ON ip_addresses FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Reject subnets whose CIDR text had host bits set (Postgres would otherwise refuse the
-- cast with a generic error; the API normalises first, this keeps raw SQL honest too).
CREATE FUNCTION parse_cidr_strict(txt text) RETURNS cidr LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  addr inet := txt::inet;
BEGIN
  IF network(addr)::inet <> addr THEN
    RAISE EXCEPTION '% has host bits set; did you mean %?', txt, network(addr) USING ERRCODE = 'KB003';
  END IF;
  RETURN network(addr);
END $$;

-- ─── CMDB relationships (graph edges, traversed with recursive CTEs) ────────
CREATE TABLE ci_relationships (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_asset_id    uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  target_asset_id    uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  relationship_type  relationship_type NOT NULL,
  attributes         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ci_relationships_no_self_loop CHECK (source_asset_id <> target_asset_id),
  UNIQUE (source_asset_id, target_asset_id, relationship_type)
);
CREATE INDEX ci_relationships_target_idx ON ci_relationships (target_asset_id, relationship_type);

-- Everything that (transitively) depends on a CI: the blast radius if it fails.
CREATE FUNCTION ci_impacted_by(root uuid, max_depth integer DEFAULT 10)
RETURNS TABLE (asset_id uuid, depth integer, path uuid[]) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE impact AS (
    SELECT r.source_asset_id AS asset_id, 1 AS depth, ARRAY[root, r.source_asset_id] AS path
    FROM ci_relationships r
    WHERE r.target_asset_id = root
    UNION ALL
    SELECT r.source_asset_id, i.depth + 1, i.path || r.source_asset_id
    FROM ci_relationships r
    JOIN impact i ON r.target_asset_id = i.asset_id
    WHERE i.depth < max_depth AND NOT r.source_asset_id = ANY (i.path)
  )
  SELECT DISTINCT ON (asset_id) asset_id, depth, path FROM impact ORDER BY asset_id, depth;
$$;

-- ─── Discovery (Phase 4 workers write here) ─────────────────────────────────
CREATE TABLE discovery_jobs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    text NOT NULL UNIQUE,
  target_cidr             cidr,
  protocol                discovery_protocol NOT NULL,
  schedule_cron           text,
  credential_ref          text,                -- key into the credential vault, never the secret
  is_enabled              boolean NOT NULL DEFAULT true,
  last_run_at             timestamptz,
  last_run_status         job_status NOT NULL DEFAULT 'never_run',
  discovered_items_count  integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT discovery_jobs_cron_shape CHECK (schedule_cron IS NULL OR array_length(regexp_split_to_array(btrim(schedule_cron), '\s+'), 1) BETWEEN 5 AND 6)
);

CREATE TABLE discovery_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id      uuid NOT NULL REFERENCES discovery_jobs (id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      job_status NOT NULL,
  items_found integer NOT NULL DEFAULT 0,
  message     text,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX discovery_logs_job_started_idx ON discovery_logs (job_id, started_at DESC);

-- ─── Audit trail (append-only) ──────────────────────────────────────────────
CREATE TABLE audit_logs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity          text NOT NULL,
  entity_id       uuid NOT NULL,
  action          audit_action NOT NULL,
  before          jsonb,
  after           jsonb,
  changed_fields  text[] NOT NULL DEFAULT '{}',
  user_id         uuid REFERENCES users (id) ON DELETE SET NULL,
  request_id      text,
  at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT audit_logs_shape CHECK (
    (action = 'create' AND before IS NULL AND after IS NOT NULL)
    OR (action = 'update' AND before IS NOT NULL AND after IS NOT NULL)
    OR (action = 'delete' AND before IS NOT NULL AND after IS NULL)
  )
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity, entity_id, at DESC);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, at DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only' USING ERRCODE = 'KB006';
END $$;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_immutable();

-- updated_at on the remaining mutable tables
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER sites_set_updated_at BEFORE UPDATE ON sites FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER buildings_set_updated_at BEFORE UPDATE ON buildings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rooms_set_updated_at BEFORE UPDATE ON rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER rack_rows_set_updated_at BEFORE UPDATE ON rack_rows FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER racks_set_updated_at BEFORE UPDATE ON racks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER manufacturers_set_updated_at BEFORE UPDATE ON manufacturers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER hardware_models_set_updated_at BEFORE UPDATE ON hardware_models FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vrfs_set_updated_at BEFORE UPDATE ON vrfs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER vlans_set_updated_at BEFORE UPDATE ON vlans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER network_ports_set_updated_at BEFORE UPDATE ON network_ports FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER discovery_jobs_set_updated_at BEFORE UPDATE ON discovery_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A rack cannot shrink below the devices already mounted in it.
CREATE FUNCTION racks_guard_height() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  tallest integer;
BEGIN
  SELECT max(upper(u_range) - 1) INTO tallest FROM asset_rack_occupancy WHERE rack_id = NEW.id;
  IF tallest IS NOT NULL AND tallest > NEW.height_u THEN
    RAISE EXCEPTION 'rack % holds a device up to U%; cannot shrink to %U', NEW.name, tallest, NEW.height_u USING ERRCODE = 'KB001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER racks_guard_height BEFORE UPDATE OF height_u ON racks FOR EACH ROW EXECUTE FUNCTION racks_guard_height();
