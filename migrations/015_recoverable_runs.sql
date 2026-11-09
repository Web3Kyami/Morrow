-- Recoverable encrypted run receipts and exclusive unsigned gas references.
-- No raw tokens or client capability keys are persisted. Gas reservations
-- intentionally never expire: unsigned bytes can outlive an app timeout.
ALTER TABLE morrow.orders ADD COLUMN product_category text CHECK (product_category IN ('course','download','subscription','pass','service'));
CREATE TABLE morrow.demo_run_receipts (
  key_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  ciphertext text NOT NULL,
  expires_at timestamptz NOT NULL
);
ALTER TABLE morrow.demo_run_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.demo_run_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.demo_run_receipts
 USING (tenant_id = nullif(current_setting('morrow.tenant_id', true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id', true),'')::uuid);
CREATE FUNCTION morrow.lookup_demo_receipt(p_key text)
RETURNS TABLE(ciphertext text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, morrow AS $$
 SELECT ciphertext, expires_at FROM morrow.demo_run_receipts WHERE key_hash=p_key;
$$;
REVOKE ALL ON FUNCTION morrow.lookup_demo_receipt(text) FROM PUBLIC;
CREATE TABLE morrow.demo_gas_reservations (
  gas_ref text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  case_id uuid NOT NULL,
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id)
);
ALTER TABLE morrow.demo_gas_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.demo_gas_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.demo_gas_reservations
 USING (tenant_id = nullif(current_setting('morrow.tenant_id', true),'')::uuid)
 WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id', true),'')::uuid);
-- B/C orders and cases exist immediately, but their intents are prepared
-- only after the preceding transaction is confirmed on-chain.
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
    INSERT INTO morrow.orders(tenant_id, id, customer_id, product_id,product_category)
    VALUES (p_tenant_id, v_case.order_id, gen_random_uuid(), gen_random_uuid(),'course');
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
CREATE FUNCTION morrow.prepare_demo_payment(
 p_tenant uuid,p_operator uuid,p_case uuid,p_digest text,p_sender text,
 p_recipient text,p_amount numeric,p_expires timestamptz
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog,morrow AS $$
DECLARE v_order uuid;
BEGIN
 PERFORM set_config('morrow.tenant_id',p_tenant::text,true);
 IF NOT EXISTS(SELECT 1 FROM morrow.operators o JOIN morrow.tenants t ON t.id=o.tenant_id
  WHERE o.tenant_id=p_tenant AND o.id=p_operator AND o.active AND o.role='judge' AND t.kind='demo')
 THEN RAISE EXCEPTION 'FORBIDDEN'; END IF;
 SELECT order_id INTO STRICT v_order FROM morrow.cases WHERE tenant_id=p_tenant AND id=p_case;
 INSERT INTO morrow.payment_intents(tenant_id,order_id,network,expected_digest,sender,recipient,coin_type,amount,expires_at)
 VALUES(p_tenant,v_order,'testnet',p_digest,p_sender,p_recipient,'0x2::sui::SUI',p_amount,p_expires);
END;
$$;
REVOKE ALL ON FUNCTION morrow.prepare_demo_payment(uuid,uuid,uuid,text,text,text,numeric,timestamptz) FROM PUBLIC;
