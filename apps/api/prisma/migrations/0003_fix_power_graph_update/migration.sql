-- 0002's sync trigger excluded the changed row by id when checking for remaining cords.
-- On UPDATE that row is the NEW cord, so re-plugging into another outlet on the same PDU
-- inserted the powered_by edge and then deleted it. AFTER triggers already see the final
-- table state (a deleted row is gone, an updated row has its new ports), so no exclusion is needed.
CREATE OR REPLACE FUNCTION power_connections_sync_graph() RETURNS trigger LANGUAGE plpgsql AS $$
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
    DELETE FROM ci_relationships r
    WHERE r.source_asset_id = src AND r.target_asset_id = dst AND r.relationship_type = 'powered_by'
      AND NOT EXISTS (
        SELECT 1 FROM power_connections pc
        JOIN power_ports i ON i.id = pc.inlet_port_id
        JOIN power_ports o ON o.id = pc.outlet_port_id
        WHERE i.asset_id = src AND o.asset_id = dst
      );
  END IF;
  RETURN NULL;
END $$;
