CREATE TABLE morrow.demo_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  tenant_id uuid NOT NULL REFERENCES morrow.tenants(id),
  operator_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  used_requests integer NOT NULL DEFAULT 0 CHECK (used_requests >= 0),
  max_requests integer NOT NULL DEFAULT 100 CHECK (max_requests BETWEEN 1 AND 1000),
  FOREIGN KEY (tenant_id,operator_id) REFERENCES morrow.operators(tenant_id,id)
);
REVOKE ALL ON morrow.demo_sessions FROM PUBLIC;
