CREATE TRIGGER interaction_append_only
  BEFORE UPDATE OR DELETE ON "interaction"
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
