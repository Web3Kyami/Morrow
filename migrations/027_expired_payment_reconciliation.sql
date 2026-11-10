-- Expired prepared transactions stay unresolved until an operator can inspect
-- the same digest. They must not churn the automatic signing queue.
CREATE OR REPLACE FUNCTION morrow.claim_demo_payment_job(p_case uuid DEFAULT NULL)
RETURNS SETOF morrow.demo_payment_jobs
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
 AND NOT (j.state='UNKNOWN' AND j.error_code IN ('SESSION_EXPIRED','EXPIRED_RECONCILIATION_REQUIRED'))
 AND NOT (j.state='UNKNOWN' AND j.error_code='POLICY_DENIED' AND NOT (t.grant_enabled AND o.active))
 ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1;
 IF candidate.case_id IS NULL THEN RETURN; END IF;
 UPDATE morrow.demo_payment_jobs SET state=CASE WHEN state='QUEUED' THEN 'PREPARING' ELSE state END,
 attempts=attempts+1,lease_until=clock_timestamp()+interval '90 seconds',updated_at=clock_timestamp()
 WHERE tenant_id=candidate.tenant_id AND case_id=candidate.case_id RETURNING * INTO candidate;
 RETURN NEXT candidate;
END;
$$;
