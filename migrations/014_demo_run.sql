-- B2 run provisioning v2: linked A/B/C cases in one tenant + idempotent resume.
-- Additive. The original provision_demo_case (013) is retained unused for
-- backward compatibility; new code uses provision_demo_run.
-- demo_provisioning_keys binds a client Idempotency-Key hash to the run it
-- created. The plain token is never stored; a resumed response returns the
-- existing case without a new token (token-once semantics, documented in
-- CURRENT_STATE.md). Keys older than 24h may be pruned by owner maintenance.
CREATE TABLE morrow.demo_provisioning_keys (
  key_hash text PRIMARY KEY CHECK (key_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  case_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE morrow.demo_provisioning_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.demo_provisioning_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.demo_provisioning_keys
  USING (tenant_id = nullif(current_setting('morrow.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id', true), '')::uuid);

CREATE FUNCTION morrow.provision_demo_run(
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
  -- Idempotent resume: same key returns the existing A case, creates nothing.
  IF p_idempotency_key_hash IS NOT NULL THEN
    SELECT k.case_id, k.tenant_id INTO v_existing_case, v_existing_tenant
    FROM morrow.demo_provisioning_keys k
    WHERE k.key_hash = p_idempotency_key_hash;
    IF v_existing_case IS NOT NULL THEN
      RETURN QUERY
      SELECT v_existing_case, 'A'::text, NULL::timestamptz, true;
      RETURN;
    END IF;
  END IF;

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
    INSERT INTO morrow.orders(tenant_id, id, customer_id, product_id)
    VALUES (p_tenant_id, v_case.order_id, gen_random_uuid(), gen_random_uuid());
    INSERT INTO morrow.payment_intents(
      tenant_id, order_id, network, expected_digest, sender, recipient,
      coin_type, amount, expires_at
    ) VALUES (
      p_tenant_id, v_case.order_id, 'testnet', v_case.digest, v_case.sender,
      v_case.recipient, '0x2::sui::SUI', v_case.amount,
      clock_timestamp() + interval '30 minutes'
    ) RETURNING payment_intents.expires_at INTO v_expires;
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
    clock_timestamp() + interval '1 hour', 100
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
