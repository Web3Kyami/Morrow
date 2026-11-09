-- Fix ambiguous return column in the session-invalidation helper.
CREATE OR REPLACE FUNCTION morrow.delete_merchant_session(p_token_hash text)
RETURNS TABLE(tenant_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
DECLARE
  v_tenant uuid;
BEGIN
  SELECT ms.tenant_id INTO v_tenant FROM morrow.merchant_sessions ms WHERE ms.token_hash = p_token_hash;
  IF v_tenant IS NULL THEN RETURN; END IF;
  DELETE FROM morrow.merchant_sessions WHERE token_hash = p_token_hash;
  RETURN QUERY SELECT v_tenant;
END;
$$;
