ALTER TABLE morrow.lessons
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE morrow.merchant_lesson_drafts (
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  payload jsonb NOT NULL,
  approval_state text NOT NULL DEFAULT 'DRAFT' CHECK (approval_state IN ('DRAFT','APPROVING','APPROVED')),
  approval_claim uuid,
  approval_lease_until timestamptz,
  approved_lesson_id uuid,
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,case_id),
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
  FOREIGN KEY (tenant_id,approved_lesson_id) REFERENCES morrow.lessons(tenant_id,id),
  FOREIGN KEY (tenant_id,updated_by) REFERENCES morrow.operators(tenant_id,id)
);
ALTER TABLE morrow.merchant_lesson_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.merchant_lesson_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.merchant_lesson_drafts
  USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);
