-- B2 public demo provisioning (additive, non-destructive).
-- A pre-auth caller cannot create tenants/orders/cases with the restricted
-- runtime role, so provisioning runs through this narrow SECURITY DEFINER
-- function, following the existing lookup_order_ref / consume_merchant_session
-- pattern. The runtime role is granted EXECUTE only (see
-- scripts/configure-runtime.ts); it cannot insert arbitrary tenants directly.
-- The function creates one isolated demo tenant, judge operator, order,
-- precommitted Testnet payment intent, case, order reference (hashes only)
-- and a 1-hour demo session. It never broadcasts, signs or pays: the digest
-- must have been computed from the exact unsigned bytes returned to the
-- caller, and a later payment check still requires real Tatum evidence.
-- No historical digest is reused: the caller supplies a fresh digest and
-- table constraints (digest/address formats, amount > 0, sender <> recipient)
-- are enforced on insert. Unique digest/reference constraints make a
-- duplicate provisioning attempt fail atomically.
CREATE FUNCTION morrow.provision_demo_case(
  p_tenant_id uuid,
  p_operator_id uuid,
  p_order_id uuid,
  p_case_id uuid,
  p_digest text,
  p_sender text,
  p_recipient text,
  p_amount numeric,
  p_reference_hash text,
  p_email_hash text,
  p_session_token_hash text
)
RETURNS TABLE(case_id uuid, expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
DECLARE
  v_expires timestamptz;
BEGIN
  PERFORM set_config('morrow.tenant_id', p_tenant_id::text, true);
  INSERT INTO morrow.tenants(id, kind, grant_enabled)
  VALUES (p_tenant_id, 'demo', true);
  INSERT INTO morrow.operators(tenant_id, id, role)
  VALUES (p_tenant_id, p_operator_id, 'judge');
  INSERT INTO morrow.orders(tenant_id, id, customer_id, product_id)
  VALUES (p_tenant_id, p_order_id, gen_random_uuid(), gen_random_uuid());
  INSERT INTO morrow.payment_intents(
    tenant_id, order_id, network, expected_digest, sender, recipient,
    coin_type, amount, expires_at
  ) VALUES (
    p_tenant_id, p_order_id, 'testnet', p_digest, p_sender, p_recipient,
    '0x2::sui::SUI', p_amount, clock_timestamp() + interval '30 minutes'
  ) RETURNING payment_intents.expires_at INTO v_expires;
  INSERT INTO morrow.cases(tenant_id, id, order_id)
  VALUES (p_tenant_id, p_case_id, p_order_id);
  INSERT INTO morrow.order_refs(tenant_id, order_id, reference_hash, email_hash)
  VALUES (p_tenant_id, p_order_id, p_reference_hash, p_email_hash);
  INSERT INTO morrow.demo_sessions(
    token_hash, tenant_id, operator_id, expires_at, max_requests
  ) VALUES (
    p_session_token_hash, p_tenant_id, p_operator_id,
    clock_timestamp() + interval '1 hour', 100
  );
  RETURN QUERY SELECT p_case_id, v_expires;
END;
$$;
REVOKE ALL ON FUNCTION morrow.provision_demo_case(
  uuid, uuid, uuid, uuid, text, text, text, numeric, text, text, text
) FROM PUBLIC;
