-- 2026-11-16: keep the admin Activity log fast as it grows.
-- The list shows the newest entries first (optionally for one person); these indexes let Postgres read them in
-- that order instead of sorting the whole table. No data is changed. Safe to run more than once.

CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
