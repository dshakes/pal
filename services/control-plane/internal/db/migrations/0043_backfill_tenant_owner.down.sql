-- 0043_backfill_tenant_owner.down.sql
--
-- This migration cannot be reversed: we do not know which rows were promoted
-- from 'member' to 'owner' by the up migration, so rolling back would
-- incorrectly demote users who were legitimately 'owner' before the migration.
--
-- No-op intentionally. Rolling back to a state before this migration means
-- re-introducing the privilege-escalation bug; do not do that in production.
SELECT 1;
