-- PostgreSQL row-locking reads require UPDATE on at least one column.
-- Runtime may lock identity rows, but may not change their identity or policy/rights.
CREATE FUNCTION morrow.immutable_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN RAISE EXCEPTION 'immutable identity'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_tenant_id BEFORE UPDATE OF id ON morrow.tenants
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_identity();
CREATE TRIGGER immutable_operator_id BEFORE UPDATE OF id ON morrow.operators
  FOR EACH ROW EXECUTE FUNCTION morrow.immutable_identity();
