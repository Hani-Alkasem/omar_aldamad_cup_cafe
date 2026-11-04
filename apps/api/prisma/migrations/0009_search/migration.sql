-- Phase 5B: global search. Trigram indexes make "contains" and typo-tolerant matching fast
-- without a separate search engine (one less service to run on-prem).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX assets_name_trgm ON assets USING gin (lower(name) gin_trgm_ops);
CREATE INDEX assets_tag_trgm ON assets USING gin (lower(asset_tag) gin_trgm_ops) WHERE asset_tag IS NOT NULL;
CREATE INDEX assets_serial_trgm ON assets USING gin (lower(serial_number) gin_trgm_ops) WHERE serial_number IS NOT NULL;
CREATE INDEX applications_name_trgm ON applications USING gin (lower(name) gin_trgm_ops);
CREATE INDEX racks_name_trgm ON racks USING gin (lower(name) gin_trgm_ops);
CREATE INDEX subnets_name_trgm ON subnets USING gin (lower(name) gin_trgm_ops) WHERE name IS NOT NULL;
CREATE INDEX contracts_number_trgm ON contracts USING gin (lower(contract_number) gin_trgm_ops);
