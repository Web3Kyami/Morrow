ALTER TABLE morrow.comparison_baselines ADD COLUMN operation_key text NOT NULL DEFAULT 'guided';
DO $$ DECLARE constraint_name text; BEGIN
SELECT conname INTO constraint_name FROM pg_constraint WHERE conrelid='morrow.comparison_baselines'::regclass AND contype='u';
EXECUTE format('ALTER TABLE morrow.comparison_baselines DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE morrow.comparison_baselines ADD UNIQUE(tenant_id,source_case_id,target_case_id,operation_key);
