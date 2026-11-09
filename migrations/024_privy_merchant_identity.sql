-- Privy authenticates a principal; this mapping grants that principal no
-- tenant or role by itself. Only an operator provisions mappings out of band.
CREATE TABLE morrow.merchant_privy_identities (
  app_id text NOT NULL CHECK (app_id ~ '^[A-Za-z0-9_-]{8,128}$'),
  subject_hash text NOT NULL CHECK (subject_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  operator_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id, subject_hash),
  FOREIGN KEY (tenant_id, operator_id) REFERENCES morrow.operators(tenant_id, id)
);
REVOKE ALL ON TABLE morrow.merchant_privy_identities FROM PUBLIC;

ALTER TABLE morrow.merchant_privy_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.merchant_privy_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.merchant_privy_identities
  USING (tenant_id = nullif(current_setting('morrow.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id', true), '')::uuid);

-- Pre-auth lookup exposes only the mapped tenant/operator. No browser or
-- runtime table access is granted; live operator status is rechecked in the
-- subsequent tenant transaction before a session is issued.
CREATE FUNCTION morrow.lookup_merchant_privy_identity(p_app_id text, p_subject_hash text)
RETURNS TABLE(tenant_id uuid, operator_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
  SELECT m.tenant_id, m.operator_id
  FROM morrow.merchant_privy_identities m
  WHERE m.app_id = p_app_id
    AND m.subject_hash = p_subject_hash
    AND m.active
$$;
REVOKE ALL ON FUNCTION morrow.lookup_merchant_privy_identity(text, text) FROM PUBLIC;
