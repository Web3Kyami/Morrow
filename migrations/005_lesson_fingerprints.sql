-- Preserve existing approvals and exact-content integrity while versioning semantic identity.
ALTER TABLE morrow.lessons ADD COLUMN content_hash text;
ALTER TABLE morrow.lessons ADD COLUMN fingerprint_version integer NOT NULL DEFAULT 1;
UPDATE morrow.lessons SET content_hash=fingerprint;
ALTER TABLE morrow.lessons ALTER COLUMN content_hash SET NOT NULL;
CREATE OR REPLACE FUNCTION morrow.protect_lesson_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.id,NEW.case_id,NEW.approved_by,NEW.policy_version,NEW.payload,NEW.fingerprint,NEW.network,NEW.account_id,NEW.namespace,NEW.content_hash,NEW.fingerprint_version)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.case_id,OLD.approved_by,OLD.policy_version,OLD.payload,OLD.fingerprint,OLD.network,OLD.account_id,OLD.namespace,OLD.content_hash,OLD.fingerprint_version)
  THEN RAISE EXCEPTION 'immutable lesson approval'; END IF;
  RETURN NEW;
END;
$$;
