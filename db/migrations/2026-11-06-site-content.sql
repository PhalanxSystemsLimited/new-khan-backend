-- Website content edited from the admin panel (contact details, terminals, destinations, FAQ, policies...).
-- One row per section; a section with no row uses the text built into the frontend.
-- Run: node scripts/run-sql.js db/migrations/2026-11-06-site-content.sql
CREATE TABLE IF NOT EXISTS site_content (
    key         VARCHAR(40) PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE site_content ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON site_content FROM anon, authenticated;
