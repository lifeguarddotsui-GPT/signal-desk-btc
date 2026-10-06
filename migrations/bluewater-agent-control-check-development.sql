-- DEVELOPMENT ONLY: apply through Agent database permissions, never deployment
-- hooks or application startup. Publish owns production schema changes.
-- Explicit boolean predicates retain their expression when schema-diff tooling
-- introspects CHECK constraints; a bare boolean was incorrectly double-wrapped.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.bluewater_agent_execution_control
  ADD CONSTRAINT bluewater_agent_execution_control_truth_check
  CHECK (singleton IS TRUE);
-- The equivalent validated replacement is already active before removing the
-- old constraint. The transaction never exposes an unconstrained table.
ALTER TABLE public.bluewater_agent_execution_control
  DROP CONSTRAINT bluewater_agent_execution_control_singleton_check;
ALTER TABLE public.bluewater_agent_execution_control
  RENAME CONSTRAINT bluewater_agent_execution_control_truth_check
  TO bluewater_agent_execution_control_singleton_check;
COMMIT;