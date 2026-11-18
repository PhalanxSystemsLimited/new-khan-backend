-- 2026-11-20: QR code on tickets.
--
-- Every booking gets ticket_token, a random code (UUID) used only in the ticket's QR code: scanning it opens
-- /t/<ticket_token>, which shows whether the ticket is valid (staff who are signed in see more). It is not the
-- PNR or the booking id, so it cannot be guessed from them. Existing bookings get a code too.
--
-- Only adds a column and an index; nothing existing changes. Safe to run more than once.
-- Until this runs, tickets simply show no QR code.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-20-ticket-qr.sql)
BEGIN;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ticket_token UUID NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX IF NOT EXISTS bookings_ticket_token_uq ON bookings (ticket_token);

COMMIT;
