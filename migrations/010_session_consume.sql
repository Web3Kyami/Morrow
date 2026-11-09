-- Session consume: increments the durable request budget and returns the
-- scoped actor; the pre-auth route has no tenant context, so it runs here.
CREATE FUNCTION morrow.consume_merchant_session(p_token_hash text)
RETURNS TABLE(tenant_id uuid, operator_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
BEGIN
  RETURN QUERY
  UPDATE morrow.merchant_sessions
  SET used_requests = used_requests + 1
  WHERE token_hash = p_token_hash
    AND expires_at > clock_timestamp()
    AND used_requests < max_requests
  RETURNING merchant_sessions.tenant_id, merchant_sessions.operator_id;
END;
$$;
REVOKE ALL ON FUNCTION morrow.consume_merchant_session(text) FROM PUBLIC;
