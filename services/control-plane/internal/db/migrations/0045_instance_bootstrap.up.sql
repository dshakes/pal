-- E11: durable "this instance has been bootstrapped" marker. One row, written
-- when the first user is seen or created, so that erasing every workspace
-- (GDPR) can never re-arm PAL_BOOTSTRAP_OWNER_EMAIL. No tenant_id by design:
-- instance-wide and RLS-exempt (see rlsExemptTables); not touched by tenant purge.
CREATE TABLE IF NOT EXISTS instance_bootstrap (
	id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
