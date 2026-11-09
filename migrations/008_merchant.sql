-- S5 merchant desk: fixture identity, server-issued sessions, tenant isolation.
-- No production password auth is introduced here; the fixture login issues a
-- signed-out-of-band session cookie only for the seeded demo merchant.
CREATE TABLE morrow.merchant_identities (
  email_hash text PRIMARY KEY CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  operator_id uuid NOT NULL,
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 50 AND 300),
  FOREIGN KEY (tenant_id, operator_id) REFERENCES morrow.operators(tenant_id, id)
);

CREATE TABLE morrow.merchant_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  operator_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_requests integer NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
  max_requests integer NOT NULL DEFAULT 1000 CHECK (max_requests BETWEEN 1 AND 1000),
  FOREIGN KEY (tenant_id, operator_id) REFERENCES morrow.operators(tenant_id, id)
);

ALTER TABLE morrow.merchant_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.merchant_identities FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.merchant_identities USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);
ALTER TABLE morrow.merchant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.merchant_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.merchant_sessions USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);

-- Fixture sign-in lookup: email hash only. SECURITY DEFINER so the
-- pre-auth login route can resolve the merchant without tenant context.
CREATE FUNCTION morrow.lookup_merchant_identity(p_email_hash text)
RETURNS TABLE(tenant_id uuid, operator_id uuid, password_hash text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
  SELECT m.tenant_id, m.operator_id, m.password_hash
  FROM morrow.merchant_identities m
  WHERE m.email_hash = p_email_hash
$$;
REVOKE ALL ON FUNCTION morrow.lookup_merchant_identity(text) FROM PUBLIC;
