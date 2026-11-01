-- 0043_backfill_tenant_owner.up.sql
--
-- Backfill: every tenant created before #411 had its first user stored with
-- role='member' (the column default) because Signup and OAuthCallback did not
-- explicitly set role='owner'. Fix this by promoting the earliest-created user
-- (deterministic tie-break on id) in any tenant that has NO owner or admin.
--
-- Tenants that already have at least one owner or admin row are untouched.

UPDATE users
SET    role = 'owner'
WHERE  id IN (
    SELECT DISTINCT ON (tenant_id)
           id
    FROM   users u
    WHERE  NOT EXISTS (
        SELECT 1 FROM users u2
        WHERE  u2.tenant_id = u.tenant_id
        AND    u2.role IN ('owner', 'admin')
    )
    ORDER BY tenant_id, created_at, id   -- deterministic: oldest first, id as tie-break
);
