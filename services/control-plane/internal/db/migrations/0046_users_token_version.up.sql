-- S-2/E5: revocable sessions. Every session JWT carries the user's
-- token_version as its `tv` claim; the control plane rejects a token whose tv
-- no longer matches (internal/handlers/session_revocation.go). Bumping the
-- column kills every session the user holds.
--
-- Explicit bumps: POST /auth/logout. The trigger below covers the rest, so no
-- code path (password reset, a future change-password or role endpoint, or an
-- operator's SQL) can change a credential or a role and leave old tokens live.
-- Deleting the user (or the workspace) needs no bump: a missing row is refused.
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION pal_users_bump_token_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
       OR NEW.role IS DISTINCT FROM OLD.role THEN
        NEW.token_version := OLD.token_version + 1;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS pal_users_bump_token_version ON users;
CREATE TRIGGER pal_users_bump_token_version BEFORE UPDATE OF password_hash, role ON users
    FOR EACH ROW EXECUTE FUNCTION pal_users_bump_token_version();
