-- Persist the A/B/C role on cases so authorization can enforce the refusal
-- boundary even before the C payment job is created.
ALTER TABLE morrow.cases
  ADD COLUMN demo_role text CHECK (demo_role IN ('A','B','C') OR demo_role IS NULL);

ALTER TABLE morrow.demo_payment_jobs
  DROP CONSTRAINT demo_payment_jobs_role_check,
  DROP CONSTRAINT demo_payment_jobs_state_check;
ALTER TABLE morrow.demo_payment_jobs
  ADD CONSTRAINT demo_payment_jobs_role_check CHECK (role IN ('A','B','C')),
  ADD CONSTRAINT demo_payment_jobs_state_check CHECK (state IN ('QUEUED','PREPARING','RESERVED','SUBMITTING','UNKNOWN','CONFIRMED','MISMATCH','FAILED','CANCELLED'));
DROP INDEX morrow.demo_payment_work_queue;
CREATE INDEX demo_payment_work_queue ON morrow.demo_payment_jobs(not_before,created_at)
  WHERE state NOT IN ('CONFIRMED','MISMATCH','FAILED','CANCELLED');

-- New runs must contain exactly one A, B and C case. Demo identity is created
-- only through this SECURITY DEFINER function; the runtime role still has no
-- direct insert authority on tenants, orders, cases, sessions or payment data.
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
BEGIN
  IF jsonb_typeof(p_cases) <> 'array' OR jsonb_array_length(p_cases) <> 3
     OR (SELECT count(DISTINCT x.role) FROM jsonb_to_recordset(p_cases) AS x(role text)) <> 3
     OR NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_cases) AS x(role text) WHERE x.role='A')
     OR NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_cases) AS x(role text) WHERE x.role='B')
     OR NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(p_cases) AS x(role text) WHERE x.role='C')
  THEN RAISE EXCEPTION 'INVALID_DEMO_RUN'; END IF;

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
    INSERT INTO morrow.orders(
      tenant_id,id,customer_id,product_id,product_category,
      customer_label,product_label,display_reference
    ) VALUES (
      p_tenant_id,v_case.order_id,gen_random_uuid(),gen_random_uuid(),
      CASE WHEN v_case.role='B' THEN 'download' ELSE 'course' END,
      CASE WHEN v_case.role='A' THEN 'Mira' WHEN v_case.role='B' THEN 'Alex Imani' ELSE 'Noor' END,
      CASE WHEN v_case.role='B' THEN 'Studio Template Bundle' ELSE 'Layered Lessons' END,
      CASE WHEN v_case.role='A' THEN '1042' WHEN v_case.role='B' THEN '1078' ELSE '1093' END
    );
    v_expires := NULL;
    IF v_case.digest IS NOT NULL THEN
      INSERT INTO morrow.payment_intents(
        tenant_id,order_id,network,expected_digest,sender,recipient,
        coin_type,amount,expires_at
      ) VALUES (
        p_tenant_id,v_case.order_id,'testnet',v_case.digest,v_case.sender,
        v_case.recipient,'0x2::sui::SUI',v_case.amount,
        clock_timestamp()+interval '30 minutes'
      ) RETURNING payment_intents.expires_at INTO v_expires;
    END IF;
    INSERT INTO morrow.cases(tenant_id,id,order_id,demo_role)
    VALUES (p_tenant_id,v_case.case_id,v_case.order_id,v_case.role);
    INSERT INTO morrow.order_refs(tenant_id,order_id,reference_hash,email_hash)
    VALUES (p_tenant_id,v_case.order_id,v_case.reference_hash,p_email_hash);
    RETURN QUERY SELECT v_case.case_id,v_case.role,v_expires,false;
  END LOOP;

  INSERT INTO morrow.demo_sessions(token_hash,tenant_id,operator_id,expires_at,max_requests)
  VALUES (p_session_token_hash,p_tenant_id,p_operator_id,clock_timestamp()+interval '1 hour',600);

  IF p_idempotency_key_hash IS NOT NULL THEN
    INSERT INTO morrow.demo_provisioning_keys(key_hash,tenant_id,case_id)
    VALUES (
      p_idempotency_key_hash,p_tenant_id,
      (SELECT x.case_id FROM jsonb_to_recordset(p_cases) AS x(case_id uuid,role text) WHERE x.role='A' LIMIT 1)
    );
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION morrow.provision_demo_run(uuid,uuid,text,text,text,jsonb) FROM PUBLIC;
