-- Public customer intake is limited to demo tenants and explicitly marked
-- fictional merchant fixtures. The marker is owner-managed, never runtime-set.
ALTER TABLE morrow.tenants
  ADD COLUMN public_demo_intake boolean NOT NULL DEFAULT false;

-- Preserve the existing fictional merchant demo on databases seeded before
-- this boundary existed. Match all three fixed demo order references, their
-- fixture buyer email hash, and the fixture merchant identity hash so no
-- ordinary merchant tenant is promoted by a broad kind-based backfill.
UPDATE morrow.tenants t
SET public_demo_intake = true
WHERE t.kind = 'merchant'
  AND EXISTS (
    SELECT 1
    FROM morrow.merchant_identities i
    WHERE i.tenant_id = t.id
      AND i.email_hash = 'a8ce9d3150b9aa5c98c28ec5c41efe8211e533bc4334ba798be3c45d8f60bce7'
  )
  AND (
    SELECT count(DISTINCT r.reference_hash)
    FROM morrow.order_refs r
    WHERE r.tenant_id = t.id
      AND r.email_hash = 'f979a1713bf697bbbf1fc65fa352d2bb2376ee4ddf41d3bb07f9fb8f6126d1db'
      AND r.reference_hash IN (
        '92625951ce251ffb23f0b544fa126c7b3183758206b89472abaf5d7f13c42ab5',
        '700335ff29ed991de62a017f9ec096a46422cff46e4c45a5012cd65e1cc6ba61',
        'd16e1491ce19c29fdb9d39d28107bcf41e562eff1b7a4df8af4f10e19b6b6739'
      )
  ) = 3;

REVOKE UPDATE ON TABLE morrow.tenants FROM PUBLIC;
REVOKE UPDATE (public_demo_intake) ON TABLE morrow.tenants FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'morrow_app') THEN
    EXECUTE 'REVOKE UPDATE ON TABLE morrow.tenants FROM morrow_app';
    EXECUTE 'REVOKE UPDATE (public_demo_intake) ON TABLE morrow.tenants FROM morrow_app';
    -- Keep the narrow privilege needed by runtime SELECT ... FOR UPDATE.
    EXECUTE 'GRANT UPDATE (id) ON TABLE morrow.tenants TO morrow_app';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION morrow.lookup_order_ref(p_reference_hash text, p_email_hash text)
RETURNS TABLE(tenant_id uuid, order_id uuid, case_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
  SELECT r.tenant_id, r.order_id, c.id
  FROM morrow.order_refs r
  JOIN morrow.cases c ON c.tenant_id = r.tenant_id AND c.order_id = r.order_id
  JOIN morrow.tenants t ON t.id = r.tenant_id
  WHERE r.reference_hash = p_reference_hash
    AND r.email_hash = p_email_hash
    AND (t.kind = 'demo' OR t.public_demo_intake)
$$;
REVOKE ALL ON FUNCTION morrow.lookup_order_ref(text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION morrow.lookup_help_access(p_case_id uuid, p_token_hash text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
  SELECT h.tenant_id
  FROM morrow.help_requests h
  JOIN morrow.tenants t ON t.id = h.tenant_id
  WHERE h.case_id = p_case_id
    AND h.access_token_hash = p_token_hash
    AND h.access_expires_at > clock_timestamp()
    AND (t.kind = 'demo' OR t.public_demo_intake)
$$;
REVOKE ALL ON FUNCTION morrow.lookup_help_access(uuid, text) FROM PUBLIC;
