-- B1 durable intake attempt budget (additive, non-destructive).
-- Previously the five-per-day check counted morrow.help_requests rows.
-- Repeated submissions update the single help_requests row for a case,
-- so the row count never reached the limit and the quota was bypassed.
-- This table is the durable, append-only record of counted attempts:
-- one row per ownership-verified intake that is permitted to create or
-- update a help request. Attempts for unknown orders or wrong emails
-- never reach this table (lookup_order_ref returns no row), preserving
-- ownership-privacy behaviour and preventing quota-locking by callers
-- who do not know the receipt email.
-- Quota window: rolling 24 hours (attempted_at > clock_timestamp() - '1 day'),
-- matching the pre-existing window. Scope: (tenant_id, order_id), i.e. per
-- order reference. One tenant cannot consume or read another tenant's quota:
-- tenant_id is part of every key and RLS is forced below.
-- Retention: attempts older than 24 hours no longer count toward quota.
-- Owner-operated maintenance may delete attempts older than 30 days;
-- the restricted runtime role is granted INSERT and SELECT only (see
-- scripts/configure-runtime.ts), never UPDATE or DELETE, so application
-- code cannot manufacture quota by deleting attempts. Pre-migration
-- help_requests are not backfilled; the attempts ledger starts empty.
CREATE TABLE morrow.help_intake_attempts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  case_id uuid NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES morrow.orders(tenant_id, id),
  FOREIGN KEY (tenant_id, case_id) REFERENCES morrow.cases(tenant_id, id)
);
CREATE INDEX help_intake_attempts_order_window
  ON morrow.help_intake_attempts(tenant_id, order_id, attempted_at DESC);
ALTER TABLE morrow.help_intake_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.help_intake_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.help_intake_attempts
  USING (tenant_id = nullif(current_setting('morrow.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('morrow.tenant_id', true), '')::uuid);
