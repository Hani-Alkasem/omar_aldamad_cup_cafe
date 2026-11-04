-- Phase 5D: live updates. Committed outbox events and run progress are announced on the
-- itam_events channel; API replicas LISTEN and fan out to browsers over Server-Sent Events.
-- NOTIFY is delivered only on commit, so a rolled-back change is never announced.

CREATE FUNCTION outbox_events_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('itam_events', json_build_object('id', NEW.id, 'type', NEW.type, 'entity', NEW.entity, 'entityId', NEW.entity_id, 'at', NEW.occurred_at)::text);
  RETURN NULL;
END $$;
CREATE TRIGGER outbox_events_notify AFTER INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION outbox_events_notify();

-- Progress is not audited (it changes every few seconds), so it gets its own lightweight signal.
CREATE FUNCTION discovery_runs_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hosts_scanned IS DISTINCT FROM OLD.hosts_scanned OR NEW.hosts_responded IS DISTINCT FROM OLD.hosts_responded OR NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM pg_notify('itam_events', json_build_object('type', 'discovery_run.progress', 'entity', 'discovery_run', 'entityId', NEW.id, 'jobId', NEW.job_id, 'status', NEW.status, 'at', now())::text);
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER discovery_runs_notify AFTER UPDATE ON discovery_runs FOR EACH ROW EXECUTE FUNCTION discovery_runs_notify();
