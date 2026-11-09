-- Help-access lookup: returns the tenant only when the unexpired access
-- token hash matches a help request for the case. SECURITY DEFINER so the
-- pre-auth status route can resolve the tenant without tenant context.
CREATE FUNCTION morrow.lookup_help_access(p_case_id uuid, p_token_hash text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
  SELECT h.tenant_id
  FROM morrow.help_requests h
  WHERE h.case_id = p_case_id
    AND h.access_token_hash = p_token_hash
    AND h.access_expires_at > clock_timestamp()
$$;
REVOKE ALL ON FUNCTION morrow.lookup_help_access(uuid, text) FROM PUBLIC;
