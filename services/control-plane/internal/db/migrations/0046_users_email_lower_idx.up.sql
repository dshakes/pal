-- 0046: OAuth sign-in resolves accounts by lower(email) across tenants
-- (resolveOAuthUser). Without this the pre-auth lookup is a seq scan on users.
-- Plain (not CONCURRENTLY): the migration runner may wrap a file in a
-- transaction, where CONCURRENTLY is an error that crash-loops startup. users
-- is small, so the brief write lock is fine. RLS on users is unaffected.
CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
