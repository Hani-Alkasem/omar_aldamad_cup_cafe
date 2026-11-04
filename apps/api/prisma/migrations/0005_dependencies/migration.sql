-- Phase 4A: application dependency mapping.
--   ci_relationships   provenance (manual vs discovery) and observation timestamps
--   applications       business services grouping assets
--   ci_dependency_graph(root, depth, direction) the edge set reachable from a CI
-- Discovered and power edges are maintained by their writers; the API refuses hand edits of them.

ALTER TABLE ci_relationships
  ADD COLUMN source text NOT NULL DEFAULT 'manual',
  ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN observation_count integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT ci_relationships_source CHECK (source IN ('manual', 'discovery', 'power')),
  ADD CONSTRAINT ci_relationships_observations CHECK (observation_count >= 1 AND last_seen_at >= first_seen_at);
CREATE INDEX ci_relationships_source_idx ON ci_relationships (source_asset_id, relationship_type);

-- Power edges are maintained by the power_connections trigger; label them.
UPDATE ci_relationships SET source = 'power' WHERE relationship_type = 'powered_by';
CREATE OR REPLACE FUNCTION power_connections_sync_graph() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  src uuid;
  dst uuid;
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    SELECT i.asset_id, o.asset_id INTO src, dst
    FROM power_ports i, power_ports o WHERE i.id = NEW.inlet_port_id AND o.id = NEW.outlet_port_id;
    INSERT INTO ci_relationships (source_asset_id, target_asset_id, relationship_type, source)
    VALUES (src, dst, 'powered_by', 'power') ON CONFLICT DO NOTHING;
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

-- ─── Applications ───────────────────────────────────────────────────────────
CREATE TYPE app_criticality AS ENUM ('tier0', 'tier1', 'tier2', 'tier3');

CREATE TABLE applications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  description  text,
  owner        text,
  criticality  app_criticality NOT NULL DEFAULT 'tier2',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT applications_name_nonblank CHECK (btrim(name) <> '')
);
CREATE UNIQUE INDEX applications_name_key ON applications (lower(name));
CREATE TRIGGER applications_set_updated_at BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE application_members (
  application_id  uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  asset_id        uuid NOT NULL REFERENCES assets (id) ON DELETE CASCADE,
  role            text,
  PRIMARY KEY (application_id, asset_id)
);
CREATE INDEX application_members_asset_idx ON application_members (asset_id);

-- ─── Graph traversal ────────────────────────────────────────────────────────
-- Edges reachable from root within max_depth hops.
--   direction 'down': what root depends on (follow source → target)
--   direction 'up':   what depends on root (follow target → source), i.e. blast radius
--   direction 'both': union of the two
-- Cycles are cut by refusing to revisit a node already on the path.
CREATE FUNCTION ci_dependency_graph(root uuid, max_depth integer DEFAULT 2, direction text DEFAULT 'both')
RETURNS TABLE (edge_id uuid, depth integer) LANGUAGE sql STABLE AS $$
  WITH RECURSIVE
  down AS (
    SELECT r.id, r.target_asset_id AS node, 1 AS depth, ARRAY[root, r.target_asset_id] AS path
    FROM ci_relationships r WHERE r.source_asset_id = root AND direction IN ('down', 'both')
    UNION ALL
    SELECT r.id, r.target_asset_id, d.depth + 1, d.path || r.target_asset_id
    FROM down d JOIN ci_relationships r ON r.source_asset_id = d.node
    WHERE d.depth < max_depth AND NOT r.target_asset_id = ANY (d.path)
  ),
  up AS (
    SELECT r.id, r.source_asset_id AS node, 1 AS depth, ARRAY[root, r.source_asset_id] AS path
    FROM ci_relationships r WHERE r.target_asset_id = root AND direction IN ('up', 'both')
    UNION ALL
    SELECT r.id, r.source_asset_id, u.depth + 1, u.path || r.source_asset_id
    FROM up u JOIN ci_relationships r ON r.target_asset_id = u.node
    WHERE u.depth < max_depth AND NOT r.source_asset_id = ANY (u.path)
  )
  SELECT id, min(depth)::integer FROM (SELECT id, depth FROM down UNION ALL SELECT id, depth FROM up) e GROUP BY id;
$$;
