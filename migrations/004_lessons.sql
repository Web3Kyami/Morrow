CREATE TABLE morrow.lessons (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  case_id uuid NOT NULL,
  approved_by uuid NOT NULL,
  policy_version integer NOT NULL,
  payload jsonb NOT NULL,
  fingerprint text NOT NULL,
  network text NOT NULL CHECK (network IN ('testnet','mainnet')),
  account_id text NOT NULL,
  namespace text NOT NULL,
  state text NOT NULL DEFAULT 'APPROVED' CHECK (state IN ('APPROVED','ACCEPTED','PENDING','COMPLETED','FAILED','UNKNOWN','RECALL_VERIFIED')),
  job_id text,
  blob_id text,
  completed_at timestamptz,
  recalled_at timestamptz,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (network,account_id,namespace,fingerprint),
  UNIQUE (network,account_id,blob_id),
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
  FOREIGN KEY (tenant_id,approved_by) REFERENCES morrow.operators(tenant_id,id),
  CHECK (state NOT IN ('ACCEPTED','PENDING','COMPLETED','RECALL_VERIFIED') OR job_id IS NOT NULL),
  CHECK (state NOT IN ('COMPLETED','RECALL_VERIFIED') OR (blob_id IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK (state <> 'RECALL_VERIFIED' OR recalled_at IS NOT NULL)
);
ALTER TABLE morrow.lessons ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.lessons FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.lessons USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);
CREATE FUNCTION morrow.protect_lesson_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id,NEW.id,NEW.case_id,NEW.approved_by,NEW.policy_version,NEW.payload,NEW.fingerprint,NEW.network,NEW.account_id,NEW.namespace)
    IS DISTINCT FROM (OLD.tenant_id,OLD.id,OLD.case_id,OLD.approved_by,OLD.policy_version,OLD.payload,OLD.fingerprint,OLD.network,OLD.account_id,OLD.namespace)
  THEN RAISE EXCEPTION 'immutable lesson approval'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_lesson_approval BEFORE UPDATE ON morrow.lessons FOR EACH ROW EXECUTE FUNCTION morrow.protect_lesson_approval();
