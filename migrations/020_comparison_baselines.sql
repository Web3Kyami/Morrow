CREATE TABLE morrow.comparison_baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  source_case_id uuid NOT NULL,
  target_case_id uuid NOT NULL,
  planner text NOT NULL,
  state text NOT NULL DEFAULT 'OFF_FAILED' CHECK (state IN ('OFF_RUNNING','OFF_DONE','ON_RUNNING','COMPLETE','OFF_FAILED','ON_FAILED')),
  frozen jsonb, off_result jsonb, result jsonb,
  claim uuid, lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,source_case_id,target_case_id),
  FOREIGN KEY(tenant_id,source_case_id) REFERENCES morrow.cases(tenant_id,id),
  FOREIGN KEY(tenant_id,target_case_id) REFERENCES morrow.cases(tenant_id,id),
  CHECK(source_case_id<>target_case_id)
);
ALTER TABLE morrow.comparison_baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.comparison_baselines FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON morrow.comparison_baselines USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);
