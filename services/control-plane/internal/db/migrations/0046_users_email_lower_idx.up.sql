-- 0046: OAuth sign-in resolves accounts by lower(email) across tenants
-- (resolveOAuthUser). Without this the pre-auth lookup is a seq scan on users.
-- CONCURRENTLY: no write lock on users while it builds. It must be the only
-- statement in the file (it cannot run inside a transaction block).
-- users is RLS-enabled; an index changes nothing about the policy.
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_email_lower_idx ON users (lower(email));
