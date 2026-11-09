CREATE SCHEMA morrow;
REVOKE ALL ON SCHEMA morrow FROM PUBLIC;

CREATE TABLE morrow.tenants (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('merchant','demo')),
  policy_version integer NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  grant_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE morrow.operators (
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('merchant','judge')),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id,id)
);
CREATE TABLE morrow.orders (
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,id,product_id)
);
CREATE TABLE morrow.payment_intents (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  network text NOT NULL CHECK (network = 'testnet'),
  expected_digest text NOT NULL CHECK (expected_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,50}$'),
  sender text NOT NULL CHECK (sender ~ '^0x[0-9a-f]{64}$'),
  recipient text NOT NULL CHECK (recipient ~ '^0x[0-9a-f]{64}$'),
  coin_type text NOT NULL,
  amount numeric(20,0) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,order_id),
  UNIQUE (network,expected_digest),
  FOREIGN KEY (tenant_id,order_id) REFERENCES morrow.orders(tenant_id,id),
  CHECK (sender <> recipient AND expires_at > created_at)
);
CREATE TABLE morrow.cases (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  order_id uuid NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,order_id),
  FOREIGN KEY (tenant_id,order_id) REFERENCES morrow.orders(tenant_id,id)
);
CREATE TABLE morrow.payment_checks (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  case_id uuid NOT NULL,
  verdict text NOT NULL CHECK (verdict IN ('MATCH','MISMATCH','UNKNOWN')),
  reason text NOT NULL,
  evidence jsonb NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id)
);
CREATE INDEX payment_checks_case ON morrow.payment_checks(tenant_id,case_id,checked_at DESC);
CREATE TABLE morrow.decisions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  case_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('APPROVED','REJECTED','CORRECTED','CANCELLED')),
  case_version integer NOT NULL,
  policy_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,case_id,case_version),
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
  FOREIGN KEY (tenant_id,operator_id) REFERENCES morrow.operators(tenant_id,id)
);
CREATE TABLE morrow.entitlements (
  tenant_id uuid NOT NULL,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,order_id,product_id),
  FOREIGN KEY (tenant_id,order_id,product_id) REFERENCES morrow.orders(tenant_id,id,product_id)
);
CREATE TABLE morrow.repairs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  case_id uuid NOT NULL,
  decision_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  fingerprint text NOT NULL,
  status text NOT NULL CHECK (status = 'EXECUTED'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id,id),
  UNIQUE (tenant_id,operator_id,idempotency_key),
  UNIQUE (tenant_id,decision_id),
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
  FOREIGN KEY (tenant_id,decision_id) REFERENCES morrow.decisions(tenant_id,id),
  FOREIGN KEY (tenant_id,operator_id) REFERENCES morrow.operators(tenant_id,id)
);
CREATE TABLE morrow.case_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  case_id uuid NOT NULL,
  operator_id uuid NOT NULL,
  kind text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id,case_id) REFERENCES morrow.cases(tenant_id,id),
  FOREIGN KEY (tenant_id,operator_id) REFERENCES morrow.operators(tenant_id,id)
);
CREATE INDEX case_events_case ON morrow.case_events(tenant_id,case_id,id);

-- Database owner still controls DDL; runtime uses a separate role without that authority.
CREATE FUNCTION morrow.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record'; END;
$$;
CREATE TRIGGER immutable_intent BEFORE UPDATE OR DELETE ON morrow.payment_intents
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_record();
CREATE TRIGGER immutable_checks BEFORE UPDATE OR DELETE ON morrow.payment_checks
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_record();
CREATE TRIGGER immutable_decisions BEFORE UPDATE OR DELETE ON morrow.decisions
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_record();
CREATE TRIGGER immutable_repairs BEFORE UPDATE OR DELETE ON morrow.repairs
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_record();
CREATE TRIGGER immutable_events BEFORE UPDATE OR DELETE ON morrow.case_events
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_record();

-- Tenant context is set transaction-locally by the server after identity verification.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['operators','orders','payment_intents','cases','payment_checks','decisions','entitlements','repairs','case_events'] LOOP
    EXECUTE format('ALTER TABLE morrow.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE morrow.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY tenant_scope ON morrow.%I USING (tenant_id = nullif(current_setting(''morrow.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''morrow.tenant_id'',true),'''')::uuid)',tab);
  END LOOP;
END $$;
ALTER TABLE morrow.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE morrow.tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON morrow.tenants USING (id = nullif(current_setting('morrow.tenant_id',true),'')::uuid);
