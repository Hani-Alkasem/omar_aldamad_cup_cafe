-- Phase 4B: transactional outbox and outbound webhooks.
--   outbox_events          domain events, written in the same transaction as the change (never updated; pruned by age)
--   webhook_subscriptions  where events go: generic signed JSON, Slack, Jira, ServiceNow (secrets sealed by the vault)
--   webhook_deliveries     one row per (subscription, event): retries, backoff, dead letters, replay
-- Fan-out happens in the database, so an event can never commit without its deliveries.

CREATE TABLE outbox_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type         text NOT NULL,
  entity       text NOT NULL,
  entity_id    text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  request_id   text,
  -- Scheduled and per-host events set this so re-runs cannot emit twice.
  dedupe_key   text UNIQUE,
  CONSTRAINT outbox_events_type_shape CHECK (type ~ '^[a-z_]+(\.[a-z_]+)+$')
);
CREATE INDEX outbox_events_entity_idx ON outbox_events (entity, entity_id, occurred_at DESC);

-- Events are facts: never rewritten. Deleting old ones (retention) is allowed and takes their deliveries along.
CREATE FUNCTION outbox_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'outbox_events rows cannot be modified' USING ERRCODE = 'KB006';
END $$;
CREATE TRIGGER outbox_events_no_update BEFORE UPDATE ON outbox_events FOR EACH ROW EXECUTE FUNCTION outbox_events_immutable();

CREATE TYPE webhook_kind AS ENUM ('generic', 'slack', 'jira', 'servicenow');
CREATE TYPE delivery_status AS ENUM ('pending', 'succeeded', 'failed', 'dead');

CREATE TABLE webhook_subscriptions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  kind               webhook_kind NOT NULL,
  url                text NOT NULL,          -- display/base URL; a Slack URL's token lives in the sealed secret
  event_types        text[] NOT NULL,
  is_enabled         boolean NOT NULL DEFAULT true,
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext  bytea NOT NULL,
  secret_iv          bytea NOT NULL,
  secret_tag         bytea NOT NULL,
  key_id             text NOT NULL,
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT webhook_subscriptions_events CHECK (cardinality(event_types) BETWEEN 1 AND 64),
  CONSTRAINT webhook_subscriptions_url CHECK (url ~ '^https?://'),
  CONSTRAINT webhook_subscriptions_iv_len CHECK (octet_length(secret_iv) = 12),
  CONSTRAINT webhook_subscriptions_tag_len CHECK (octet_length(secret_tag) = 16)
);
CREATE UNIQUE INDEX webhook_subscriptions_name_key ON webhook_subscriptions (lower(name));
CREATE INDEX webhook_subscriptions_events_idx ON webhook_subscriptions USING gin (event_types) WHERE is_enabled;
CREATE TRIGGER webhook_subscriptions_set_updated_at BEFORE UPDATE ON webhook_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE webhook_deliveries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subscription_id   uuid NOT NULL REFERENCES webhook_subscriptions (id) ON DELETE CASCADE,
  event_id          bigint NOT NULL REFERENCES outbox_events (id) ON DELETE CASCADE,
  status            delivery_status NOT NULL DEFAULT 'pending',
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz NOT NULL DEFAULT now(),
  last_status_code  integer,
  last_error        text,
  response_ms       integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  delivered_at      timestamptz,
  UNIQUE (subscription_id, event_id),
  CONSTRAINT webhook_deliveries_attempts CHECK (attempts >= 0),
  CONSTRAINT webhook_deliveries_delivered CHECK ((status = 'succeeded') = (delivered_at IS NOT NULL))
);
-- The dispatcher's work queue.
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'failed');
CREATE INDEX webhook_deliveries_sub_idx ON webhook_deliveries (subscription_id, created_at DESC);

-- Fan out each event to every enabled subscription whose patterns match: exact type, "<entity>.*" or "*".
-- webhook.ping is addressed to one subscription explicitly and never fans out.
CREATE FUNCTION outbox_events_fan_out() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type = 'webhook.ping' THEN RETURN NULL; END IF;
  INSERT INTO webhook_deliveries (subscription_id, event_id)
  SELECT s.id, NEW.id FROM webhook_subscriptions s
  WHERE s.is_enabled AND s.event_types && ARRAY['*', NEW.type, split_part(NEW.type, '.', 1) || '.*']
  ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_events_fan_out AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION outbox_events_fan_out();
