-- Durable, bounded Testnet-only payment work. Web requests never sign.
CREATE TABLE morrow.demo_payment_jobs (
 tenant_id uuid NOT NULL,
 case_id uuid NOT NULL,
 operator_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('A','B')),
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','PREPARING','RESERVED','SUBMITTING','UNKNOWN','CONFIRMED','FAILED','CANCELLED')),
 digest text, transaction_bytes text,
 gas_budget numeric(20,0), amount numeric(20,0),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
 lease_until timestamptz, not_before timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
 error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,case_id), UNIQUE(tenant_id,role),
 FOREIGN KEY(tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
 FOREIGN KEY(tenant_id,operator_id) REFERENCES morrow.operators(tenant_id,id),
 CHECK(state NOT IN ('RESERVED','SUBMITTING','UNKNOWN','CONFIRMED') OR (digest IS NOT NULL AND transaction_bytes IS NOT NULL))
);
ALTER TABLE morrow.demo_payment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.demo_payment_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.demo_payment_jobs
 USING(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('morrow.tenant_id',true),'')::uuid);
CREATE INDEX demo_payment_work_queue ON morrow.demo_payment_jobs(not_before,created_at) WHERE state NOT IN ('CONFIRMED','FAILED','CANCELLED');
CREATE TABLE morrow.demo_signing_budget (
 day date PRIMARY KEY, reserved_mist numeric(20,0) NOT NULL, operations integer NOT NULL
);
REVOKE ALL ON morrow.demo_signing_budget FROM PUBLIC;
CREATE FUNCTION morrow.reserve_demo_signing_budget(p_mist numeric) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow AS $$
DECLARE ok boolean;
BEGIN
 IF p_mist<=0 OR p_mist>11500000 THEN RAISE EXCEPTION 'DEMO_BUDGET_EXCEEDED'; END IF;
 INSERT INTO morrow.demo_signing_budget(day,reserved_mist,operations)
 VALUES((clock_timestamp() AT TIME ZONE 'UTC')::date,p_mist,1)
 ON CONFLICT(day) DO UPDATE SET reserved_mist=demo_signing_budget.reserved_mist+EXCLUDED.reserved_mist,operations=demo_signing_budget.operations+1
 WHERE demo_signing_budget.reserved_mist+EXCLUDED.reserved_mist<=100000000 AND demo_signing_budget.operations<20
 RETURNING true INTO ok;
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'DEMO_BUDGET_EXCEEDED'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION morrow.reserve_demo_signing_budget(numeric) FROM PUBLIC;
CREATE FUNCTION morrow.claim_demo_payment_job(p_case uuid DEFAULT NULL) RETURNS SETOF morrow.demo_payment_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,morrow AS $$
DECLARE candidate morrow.demo_payment_jobs;
BEGIN
 UPDATE morrow.demo_payment_jobs j SET state='CANCELLED',error_code='SESSION_EXPIRED'
 WHERE state IN ('QUEUED','PREPARING') AND digest IS NULL AND (expires_at<=clock_timestamp() OR NOT EXISTS(
 SELECT 1 FROM morrow.demo_sessions s WHERE s.tenant_id=j.tenant_id AND s.expires_at>clock_timestamp() AND s.used_requests<s.max_requests));
 SELECT j.* INTO candidate FROM morrow.demo_payment_jobs j JOIN morrow.tenants t ON t.id=j.tenant_id
 JOIN morrow.operators o ON o.tenant_id=j.tenant_id AND o.id=j.operator_id
 WHERE t.kind='demo' AND o.role='judge' AND o.active
 AND (p_case IS NULL OR j.case_id=p_case)
 AND j.state IN ('QUEUED','PREPARING','RESERVED','SUBMITTING','UNKNOWN') AND j.attempts<20
 AND j.not_before<=clock_timestamp() AND (j.lease_until IS NULL OR j.lease_until<clock_timestamp())
 ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF candidate.case_id IS NULL THEN RETURN; END IF;
 UPDATE morrow.demo_payment_jobs SET state=CASE WHEN state='QUEUED' THEN 'PREPARING' ELSE state END,
 attempts=attempts+1,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
 WHERE tenant_id=candidate.tenant_id AND case_id=candidate.case_id RETURNING * INTO candidate;
 RETURN NEXT candidate;
END;
$$;
REVOKE ALL ON FUNCTION morrow.claim_demo_payment_job(uuid) FROM PUBLIC;
