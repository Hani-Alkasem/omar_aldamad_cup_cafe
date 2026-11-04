-- Phase 2: asset lifecycle & financials, structured cabling, and power distribution.
--
-- New custom SQLSTATEs:
--   KB010 power connection between incompatible ports
--   KB011 pass-through pairing invalid
--   KB012 financial values inconsistent

CREATE TYPE contract_type AS ENUM ('warranty', 'support', 'lease', 'maintenance', 'license');
CREATE TYPE depreciation_method AS ENUM ('none', 'straight_line', 'declining_balance');
CREATE TYPE port_kind AS ENUM ('ethernet', 'sfp', 'qsfp', 'console', 'management', 'patch_front', 'patch_rear');
CREATE TYPE power_port_kind AS ENUM ('inlet', 'outlet');
CREATE TYPE power_feed AS ENUM ('A', 'B', 'C');

-- ─── Vendors, purchase orders ───────────────────────────────────────────────
CREATE TABLE vendors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text NOT NULL,
  website        text,
  support_email  text,
  support_phone  text,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendors_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT vendors_email_format CHECK (support_email IS NULL OR support_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);
CREATE UNIQUE INDEX vendors_name_key ON vendors (lower(name));
CREATE TRIGGER vendors_set_updated_at BEFORE UPDATE ON vendors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number     text NOT NULL UNIQUE,
  vendor_id     uuid NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
  order_date    date NOT NULL,
  total_amount  numeric(14, 2),
  currency      char(3) NOT NULL DEFAULT 'USD',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT purchase_orders_amount_nonneg CHECK (total_amount IS NULL OR total_amount >= 0),
  CONSTRAINT purchase_orders_currency_iso CHECK (currency ~ '^[A-Z]{3}$')
);
CREATE INDEX purchase_orders_vendor_idx ON purchase_orders (vendor_id);
CREATE TRIGGER purchase_orders_set_updated_at BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Asset financials (1:1 with assets) ─────────────────────────────────────
CREATE TABLE asset_financials (
  asset_id             uuid PRIMARY KEY REFERENCES assets (id) ON DELETE CASCADE,
  purchase_order_id    uuid REFERENCES purchase_orders (id) ON DELETE SET NULL,
  purchase_date        date,
  in_service_date      date,
  purchase_cost        numeric(14, 2),
  currency             char(3) NOT NULL DEFAULT 'USD',
  depreciation_method  depreciation_method NOT NULL DEFAULT 'straight_line',
  useful_life_months   integer,
  salvage_value        numeric(14, 2) NOT NULL DEFAULT 0,
  disposal_date        date,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_financials_cost_nonneg CHECK (purchase_cost IS NULL OR purchase_cost >= 0),
  CONSTRAINT asset_financials_salvage_range CHECK (salvage_value >= 0 AND (purchase_cost IS NULL OR salvage_value <= purchase_cost)),
  CONSTRAINT asset_financials_life_positive CHECK (useful_life_months IS NULL OR useful_life_months BETWEEN 1 AND 600),
  CONSTRAINT asset_financials_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT asset_financials_dates_ordered CHECK (
    (in_service_date IS NULL OR purchase_date IS NULL OR in_service_date >= purchase_date)
    AND (disposal_date IS NULL OR purchase_date IS NULL OR disposal_date >= purchase_date)
  ),
  -- Depreciating needs a cost and a life to depreciate over.
  CONSTRAINT asset_financials_depreciable CHECK (
    depreciation_method = 'none' OR (purchase_cost IS NOT NULL AND useful_life_months IS NOT NULL)
  )
);
CREATE INDEX asset_financials_po_idx ON asset_financials (purchase_order_id);
CREATE TRIGGER asset_financials_set_updated_at BEFORE UPDATE ON asset_financials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Contracts: warranty, support, lease, maintenance, licence ──────────────
CREATE TABLE contracts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id        uuid NOT NULL REFERENCES vendors (id) ON DELETE RESTRICT,
  contract_type    contract_type NOT NULL,
  contract_number  text NOT NULL,
  start_date       date NOT NULL,
  end_date         date NOT NULL,
  cost             numeric(14, 2),
  currency         char(3) NOT NULL DEFAULT 'USD',
  auto_renew       boolean NOT NULL DEFAULT false,
  notice_days      integer NOT NULL DEFAULT 30,
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contracts_dates_ordered CHECK (end_date >= start_date),
  CONSTRAINT contracts_cost_nonneg CHECK (cost IS NULL OR cost >= 0),
  CONSTRAINT contracts_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT contracts_notice_range CHECK (notice_days BETWEEN 0 AND 365),
  UNIQUE (vendor_id, contract_number)
);
CREATE INDEX contracts_end_date_idx ON contracts (end_date);
CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE contract_assets (
  contract_id  uuid NOT NULL REFERENCES contracts (id) ON DELETE CASCADE,
  asset_id     uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  PRIMARY KEY (contract_id, asset_id)
);
CREATE INDEX contract_assets_asset_idx ON contract_assets (asset_id);

-- ─── Maintenance schedules ──────────────────────────────────────────────────
CREATE TABLE maintenance_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id       uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  title          text NOT NULL,
  interval_days  integer NOT NULL,
  first_due_on   date NOT NULL,
  last_done_on   date,
  next_due_on    date GENERATED ALWAYS AS (COALESCE(last_done_on + interval_days, first_due_on)) STORED,
  notes          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_interval_range CHECK (interval_days BETWEEN 1 AND 3650),
  CONSTRAINT maintenance_title_not_blank CHECK (length(btrim(title)) > 0)
);
CREATE INDEX maintenance_next_due_idx ON maintenance_schedules (next_due_on);
CREATE INDEX maintenance_asset_idx ON maintenance_schedules (asset_id);
CREATE TRIGGER maintenance_schedules_set_updated_at BEFORE UPDATE ON maintenance_schedules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Structured cabling ─────────────────────────────────────────────────────
ALTER TABLE network_ports
  ADD COLUMN kind port_kind NOT NULL DEFAULT 'ethernet',
  ADD COLUMN position smallint,
  -- Patch panels: front port N is wired internally to rear port N.
  ADD COLUMN pass_through_port_id uuid REFERENCES network_ports (id) ON DELETE SET NULL,
  ADD CONSTRAINT network_ports_no_self_pass_through CHECK (pass_through_port_id IS NULL OR pass_through_port_id <> id),
  ADD CONSTRAINT network_ports_position_positive CHECK (position IS NULL OR position >= 1);
CREATE UNIQUE INDEX network_ports_pass_through_key ON network_ports (pass_through_port_id) WHERE pass_through_port_id IS NOT NULL;
CREATE UNIQUE INDEX network_ports_asset_position_key ON network_ports (asset_id, kind, position) WHERE position IS NOT NULL;

-- A pass-through pairs a front and a rear port on the same patch panel, symmetrically.
CREATE FUNCTION network_ports_check_pass_through() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  peer network_ports%ROWTYPE;
BEGIN
  IF NEW.pass_through_port_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO peer FROM network_ports WHERE id = NEW.pass_through_port_id;
  IF peer.asset_id <> NEW.asset_id THEN
    RAISE EXCEPTION 'pass-through must stay on one patch panel' USING ERRCODE = 'KB011';
  END IF;
  IF NOT ((NEW.kind = 'patch_front' AND peer.kind = 'patch_rear') OR (NEW.kind = 'patch_rear' AND peer.kind = 'patch_front')) THEN
    RAISE EXCEPTION 'pass-through joins a patch_front port to a patch_rear port' USING ERRCODE = 'KB011';
  END IF;
  IF peer.pass_through_port_id IS NOT NULL AND peer.pass_through_port_id <> NEW.id THEN
    RAISE EXCEPTION 'port % is already paired', peer.port_name USING ERRCODE = 'KB011';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER network_ports_check_pass_through
  BEFORE INSERT OR UPDATE OF pass_through_port_id, kind ON network_ports
  FOR EACH ROW EXECUTE FUNCTION network_ports_check_pass_through();

-- Keep the pairing symmetric: setting A→B also sets B→A (and clears stale back-links).
CREATE FUNCTION network_ports_mirror_pass_through() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.pass_through_port_id IS DISTINCT FROM NEW.pass_through_port_id AND OLD.pass_through_port_id IS NOT NULL THEN
    UPDATE network_ports SET pass_through_port_id = NULL WHERE id = OLD.pass_through_port_id AND pass_through_port_id = NEW.id;
  END IF;
  IF NEW.pass_through_port_id IS NOT NULL THEN
    UPDATE network_ports SET pass_through_port_id = NEW.id WHERE id = NEW.pass_through_port_id AND pass_through_port_id IS DISTINCT FROM NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER network_ports_mirror_pass_through
  AFTER INSERT OR UPDATE OF pass_through_port_id ON network_ports
  FOR EACH ROW EXECUTE FUNCTION network_ports_mirror_pass_through();

ALTER TABLE cables ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TRIGGER cables_set_updated_at BEFORE UPDATE ON cables FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ─── Power distribution ─────────────────────────────────────────────────────
CREATE TABLE power_ports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id    uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  name        text NOT NULL,
  kind        power_port_kind NOT NULL,
  feed        power_feed,                 -- which upstream feed an outlet belongs to
  voltage     smallint NOT NULL DEFAULT 230,
  max_amps    numeric(6, 2),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT power_ports_voltage_range CHECK (voltage BETWEEN 1 AND 1000),
  CONSTRAINT power_ports_amps_positive CHECK (max_amps IS NULL OR max_amps > 0),
  UNIQUE (asset_id, name)
);
CREATE INDEX power_ports_asset_idx ON power_ports (asset_id, kind);
CREATE TRIGGER power_ports_set_updated_at BEFORE UPDATE ON power_ports FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One cord per outlet, one cord per inlet; a cord runs from an outlet to an inlet of another device.
CREATE TABLE power_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_port_id   uuid NOT NULL REFERENCES power_ports (id) ON DELETE CASCADE,
  inlet_port_id    uuid NOT NULL REFERENCES power_ports (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT power_connections_distinct CHECK (outlet_port_id <> inlet_port_id)
);
CREATE UNIQUE INDEX power_connections_outlet_key ON power_connections (outlet_port_id);
CREATE UNIQUE INDEX power_connections_inlet_key ON power_connections (inlet_port_id);

CREATE FUNCTION power_connections_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o power_ports%ROWTYPE;
  i power_ports%ROWTYPE;
BEGIN
  SELECT * INTO o FROM power_ports WHERE id = NEW.outlet_port_id;
  SELECT * INTO i FROM power_ports WHERE id = NEW.inlet_port_id;
  IF o.kind <> 'outlet' OR i.kind <> 'inlet' THEN
    RAISE EXCEPTION 'a power cord runs from an outlet to an inlet' USING ERRCODE = 'KB010';
  END IF;
  IF o.asset_id = i.asset_id THEN
    RAISE EXCEPTION 'a device cannot power itself' USING ERRCODE = 'KB010';
  END IF;
  IF o.voltage <> i.voltage THEN
    RAISE EXCEPTION 'voltage mismatch: outlet %V, inlet %V', o.voltage, i.voltage USING ERRCODE = 'KB010';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER power_connections_validate BEFORE INSERT OR UPDATE ON power_connections FOR EACH ROW EXECUTE FUNCTION power_connections_validate();

-- A powered_by edge in the CMDB graph mirrors physical power, so blast-radius queries see it.
CREATE FUNCTION power_connections_sync_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src uuid;
  dst uuid;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT i.asset_id, o.asset_id INTO src, dst
    FROM power_ports i, power_ports o WHERE i.id = NEW.inlet_port_id AND o.id = NEW.outlet_port_id;
    INSERT INTO ci_relationships (source_asset_id, target_asset_id, relationship_type)
    VALUES (src, dst, 'powered_by') ON CONFLICT DO NOTHING;
  END IF;
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    SELECT i.asset_id, o.asset_id INTO src, dst
    FROM power_ports i, power_ports o WHERE i.id = OLD.inlet_port_id AND o.id = OLD.outlet_port_id;
    -- Drop the edge only when no other cord still links the same two devices.
    DELETE FROM ci_relationships r
    WHERE r.source_asset_id = src AND r.target_asset_id = dst AND r.relationship_type = 'powered_by'
      AND NOT EXISTS (
        SELECT 1 FROM power_connections pc
        JOIN power_ports i ON i.id = pc.inlet_port_id
        JOIN power_ports o ON o.id = pc.outlet_port_id
        WHERE i.asset_id = src AND o.asset_id = dst AND pc.id <> OLD.id
      );
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER power_connections_sync_graph
  AFTER INSERT OR UPDATE OR DELETE ON power_connections
  FOR EACH ROW EXECUTE FUNCTION power_connections_sync_graph();
