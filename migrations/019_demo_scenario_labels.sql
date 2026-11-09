-- Approved fictional story labels belong to each newly created demo order.
-- Existing real orders are not backfilled with sample personas.
ALTER TABLE morrow.orders ADD COLUMN customer_label text CHECK(char_length(customer_label)<=80),ADD COLUMN product_label text CHECK(char_length(product_label)<=120),ADD COLUMN display_reference text CHECK(char_length(display_reference)<=40);
CREATE OR REPLACE FUNCTION morrow.provision_demo_run(
  p_tenant_id uuid,
  p_operator_id uuid,
  p_session_token_hash text,
  p_idempotency_key_hash text,
  p_email_hash text,
  p_cases jsonb
)
RETURNS TABLE(case_id uuid, role text, expires_at timestamptz, resumed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = morrow, pg_catalog
AS $$
DECLARE
  v_case record;
  v_expires timestamptz;
  v_existing_case uuid;
  v_existing_tenant uuid;
BEGIN
  PERFORM set_config('morrow.tenant_id', p_tenant_id::text, true);
  INSERT INTO morrow.tenants(id, kind, grant_enabled)
  VALUES (p_tenant_id, 'demo', true);
  INSERT INTO morrow.operators(tenant_id, id, role)
  VALUES (p_tenant_id, p_operator_id, 'judge');

  FOR v_case IN
    SELECT * FROM jsonb_to_recordset(p_cases) AS x(
      case_id uuid, order_id uuid, digest text, sender text,
      recipient text, amount numeric, reference_hash text, role text
    )
  LOOP
    INSERT INTO morrow.orders(tenant_id, id, customer_id, product_id,product_category,customer_label,product_label,display_reference)
    VALUES (p_tenant_id, v_case.order_id, gen_random_uuid(), gen_random_uuid(),CASE WHEN v_case.role='B' THEN 'download' ELSE 'course' END,CASE WHEN v_case.role='A' THEN 'Mira' WHEN v_case.role='B' THEN 'Alex Imani' ELSE 'Noor' END,CASE WHEN v_case.role='B' THEN 'Studio Template Bundle' ELSE 'Layered Lessons' END,CASE WHEN v_case.role='A' THEN '1042' WHEN v_case.role='B' THEN '1078' ELSE '1093' END);
    v_expires := NULL;
    IF v_case.digest IS NOT NULL THEN
    INSERT INTO morrow.payment_intents(
      tenant_id, order_id, network, expected_digest, sender, recipient,
      coin_type, amount, expires_at
    ) VALUES (
      p_tenant_id, v_case.order_id, 'testnet', v_case.digest, v_case.sender,
      v_case.recipient, '0x2::sui::SUI', v_case.amount,
      clock_timestamp() + interval '30 minutes'
    ) RETURNING payment_intents.expires_at INTO v_expires;
    END IF;
    INSERT INTO morrow.cases(tenant_id, id, order_id)
    VALUES (p_tenant_id, v_case.case_id, v_case.order_id);
    INSERT INTO morrow.order_refs(tenant_id, order_id, reference_hash, email_hash)
    VALUES (p_tenant_id, v_case.order_id, v_case.reference_hash, p_email_hash);
    RETURN QUERY SELECT v_case.case_id, v_case.role, v_expires, false;
  END LOOP;

  INSERT INTO morrow.demo_sessions(
    token_hash, tenant_id, operator_id, expires_at, max_requests
  ) VALUES (
    p_session_token_hash, p_tenant_id, p_operator_id,
    clock_timestamp() + interval '1 hour', 600
  );

  IF p_idempotency_key_hash IS NOT NULL THEN
    INSERT INTO morrow.demo_provisioning_keys(key_hash, tenant_id, case_id)
    VALUES (p_idempotency_key_hash, p_tenant_id,
            (SELECT x.case_id FROM jsonb_to_recordset(p_cases) AS x(case_id uuid, role text) WHERE x.role = 'A' LIMIT 1));
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION morrow.provision_demo_run(
  uuid, uuid, text, text, text, jsonb
) FROM PUBLIC;
