-- Round trip reports made automatically.
--   * terminals.is_origin: where a bus's round trip starts and ends (Lahore and Multan). A round trip is everything
--     a bus does from leaving an origin terminal until it next ARRIVES at any origin terminal (not necessarily the
--     same one): e.g. Lahore -> Islamabad -> DI Khan -> Mianwali -> Lahore, or Lahore -> DI Khan -> Multan.
--   * When such a trip is marked Arrived, the draft report is created from the bus's trips and their vouchers
--     (round_trips.auto_created). Admins add diesel, E-tag and the other manual figures, then finalize.
-- Only adds columns; sets the flag for the Lahore and Multan terminals. Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-12-origin-terminals-auto-reports.sql   (or the Supabase SQL Editor)
BEGIN;

ALTER TABLE terminals ADD COLUMN IF NOT EXISTS is_origin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE terminals t SET is_origin = TRUE
FROM cities c
WHERE c.id = t.city_id AND lower(c.name) IN ('lahore', 'multan') AND NOT t.is_origin;

ALTER TABLE round_trips ADD COLUMN IF NOT EXISTS auto_created BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
