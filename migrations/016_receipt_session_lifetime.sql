-- A saved receipt must never revive an expired, exhausted or reset session.
CREATE OR REPLACE FUNCTION morrow.lookup_demo_receipt(p_key text)
RETURNS TABLE(ciphertext text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, morrow AS $$
 SELECT r.ciphertext,
 CASE WHEN EXISTS(SELECT 1 FROM morrow.demo_sessions s WHERE s.tenant_id=r.tenant_id
   AND s.expires_at>clock_timestamp() AND s.used_requests<s.max_requests)
 THEN r.expires_at ELSE '-infinity'::timestamptz END
 FROM morrow.demo_run_receipts r WHERE r.key_hash=p_key;
$$;
