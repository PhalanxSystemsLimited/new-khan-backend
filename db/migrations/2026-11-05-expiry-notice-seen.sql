-- When the customer was shown the "your reservation expired" notice for this booking (per account, any device).
-- Run: node scripts/run-sql.js db/migrations/2026-11-05-expiry-notice-seen.sql
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS expiry_seen_at TIMESTAMPTZ;
