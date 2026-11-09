CREATE TABLE morrow.demo_lesson_drafts (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 payload jsonb NOT NULL,approved_lesson_id uuid,approval_state text NOT NULL DEFAULT 'DRAFT' CHECK(approval_state IN('DRAFT','APPROVING','APPROVED')),approval_claim uuid,approval_lease_until timestamptz,
 PRIMARY KEY(tenant_id,case_id),FOREIGN KEY(tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,approved_lesson_id) REFERENCES morrow.lessons(tenant_id,id)
);
ALTER TABLE morrow.demo_lesson_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.demo_lesson_drafts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.demo_lesson_drafts USING(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid);
ALTER TABLE morrow.lessons ADD COLUMN submission_attempt integer NOT NULL DEFAULT 0 CHECK(submission_attempt BETWEEN 0 AND 3);
CREATE TABLE morrow.demo_lesson_jobs (
 tenant_id uuid NOT NULL,lesson_id uuid NOT NULL,state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','DONE','FAILED')),
 attempts integer NOT NULL DEFAULT 0,retries integer NOT NULL DEFAULT 0 CHECK(retries BETWEEN 0 AND 3),lease_until timestamptz,
 not_before timestamptz NOT NULL DEFAULT clock_timestamp(),error_code text,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,lesson_id),FOREIGN KEY(tenant_id,lesson_id) REFERENCES morrow.lessons(tenant_id,id)
);
ALTER TABLE morrow.demo_lesson_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.demo_lesson_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.demo_lesson_jobs USING(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid);
CREATE FUNCTION morrow.enqueue_demo_lesson() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM morrow.tenants WHERE id=NEW.tenant_id AND kind='demo') THEN
 INSERT INTO morrow.demo_lesson_jobs(tenant_id,lesson_id) VALUES(NEW.tenant_id,NEW.id) ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER demo_lesson_outbox AFTER INSERT ON morrow.lessons FOR EACH ROW EXECUTE FUNCTION morrow.enqueue_demo_lesson();
CREATE FUNCTION morrow.claim_demo_lesson_job(p_lesson uuid DEFAULT NULL)
RETURNS TABLE(tenant_id uuid,lesson_id uuid,operator_id uuid,lesson_state text,policy_version integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow AS $$
DECLARE candidate morrow.demo_lesson_jobs;
BEGIN
 UPDATE morrow.demo_lesson_jobs j SET state='FAILED',error_code='RETRY_EXHAUSTED' WHERE j.attempts>=30 AND j.state IN('QUEUED','RUNNING') AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp());
 SELECT j.* INTO candidate FROM morrow.demo_lesson_jobs j JOIN morrow.tenants t ON t.id=j.tenant_id
 WHERE t.kind='demo' AND j.state IN('QUEUED','RUNNING') AND j.attempts<30 AND j.not_before<=clock_timestamp()
 AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp()) AND (p_lesson IS NULL OR j.lesson_id=p_lesson)
 ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF candidate.lesson_id IS NULL THEN RETURN; END IF;
 UPDATE morrow.demo_lesson_jobs j SET state='RUNNING',attempts=j.attempts+1,lease_until=clock_timestamp()+interval '90 seconds'
 WHERE j.tenant_id=candidate.tenant_id AND j.lesson_id=candidate.lesson_id;
 RETURN QUERY SELECT l.tenant_id,l.id,l.approved_by,l.state,l.policy_version FROM morrow.lessons l WHERE l.tenant_id=candidate.tenant_id AND l.id=candidate.lesson_id;
END;
$$;
REVOKE ALL ON FUNCTION morrow.claim_demo_lesson_job(uuid),morrow.enqueue_demo_lesson() FROM PUBLIC;
CREATE TABLE morrow.investigation_runs (
 tenant_id uuid NOT NULL,case_id uuid NOT NULL,case_version integer NOT NULL,policy_version integer NOT NULL,planner text NOT NULL,
 state text NOT NULL CHECK(state IN('RUNNING','SUCCEEDED','FAILED')),claim_id uuid NOT NULL,
 evidence_hash text NOT NULL,result jsonb,lease_until timestamptz NOT NULL,attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 3),
 PRIMARY KEY(tenant_id,case_id,case_version,policy_version,planner),FOREIGN KEY(tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id)
);
ALTER TABLE morrow.investigation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.investigation_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.investigation_runs USING(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid);

-- Polling and approved A/B taxonomy for new isolated runs only.
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
    VALUES (p_tenant_id, v_case.order_id, gen_random_uuid(), gen_random_uuid(),CASE WHEN v_case.role='B' THEN 'download' ELSE 'course' END);
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
