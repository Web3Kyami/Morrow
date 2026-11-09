-- Session invalidation helper: the pre-auth logout route cannot know the
-- tenant, so invalidation runs through this narrow function.
CREATE FUNCTION morrow.delete_merchant_session(p_token_hash text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM morrow.merchant_sessions WHERE token_hash = p_token_hash;
  IF v_tenant IS NULL THEN RETURN; END IF;
  DELETE FROM morrow.merchant_sessions WHERE token_hash = p_token_hash;
  RETURN QUERY SELECT v_tenant;
END;
$$;
REVOKE ALL ON FUNCTION morrow.delete_merchant_session(text) FROM PUBLIC;
