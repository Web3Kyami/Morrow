-- S4 customer intake: order references are verified by hashes only.
-- The plain order reference and email never touch the database.
CREATE TABLE morrow.order_refs (
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  order_id uuid NOT NULL,
  reference_hash text NOT NULL CHECK (reference_hash ~ '^[a-f0-9]{64}$'),
  email_hash text NOT NULL CHECK (email_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, order_id),
  UNIQUE (reference_hash),
  FOREIGN KEY (tenant_id, order_id) REFERENCES morrow.orders(tenant_id, id)
);

CREATE TABLE morrow.help_requests (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  case_id uuid NOT NULL,
  issue text NOT NULL CHECK (char_length(issue) BETWEEN 5 AND 500),
  access_token_hash text NOT NULL CHECK (access_token_hash ~ '^[a-f0-9]{64}$'),
  access_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, case_id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES morrow.cases(tenant_id, id)
);

ALTER TABLE morrow.order_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.order_refs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.order_refs USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);
ALTER TABLE morrow.help_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.help_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.help_requests USING (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);

-- Ownership lookup: both hashes must match one order. SECURITY DEFINER so the
-- pre-auth intake route can resolve the tenant without tenant context; it
-- returns ids only, never the stored hashes.
CREATE FUNCTION morrow.lookup_order_ref(p_reference_hash text, p_email_hash text)
RETURNS TABLE(tenant_id uuid, order_id uuid, case_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
  SELECT r.tenant_id, r.order_id, c.id
  FROM morrow.order_refs r
  JOIN morrow.cases c ON c.tenant_id = r.tenant_id AND c.order_id = r.order_id
  WHERE r.reference_hash = p_reference_hash AND r.email_hash = p_email_hash
$$;
REVOKE ALL ON FUNCTION morrow.lookup_order_ref(text, text) FROM PUBLIC;
