DROP TRIGGER IF EXISTS pal_users_bump_token_version ON users;
DROP FUNCTION IF EXISTS pal_users_bump_token_version();
ALTER TABLE users DROP COLUMN IF EXISTS token_version;
