-- 2026-11-22: tickets are sold on the departure, the bus is confirmed at departure time.
--
-- trips.bus_confirmed: FALSE means the trip's bus is only PLANNED. It fixes the seat type (49- or 31-seater) and
-- class the tickets are sold on. At departure time the counter, a manager or an admin confirms the bus that
-- actually goes (Trips & boarding → Bus & crew): the planned bus or another free bus of the same seat type.
-- A planned bus never blocks another trip, and a trip cannot get a voucher, board or depart until its bus is
-- confirmed. "Create trips" and extra departures without a bus make planned trips.
--
-- Every trip that already exists becomes confirmed (DEFAULT TRUE), so nothing changes for them.
-- Only adds a column; safe to run more than once. Until this runs, every trip counts as confirmed.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-22-bus-confirm.sql)
BEGIN;

ALTER TABLE trips ADD COLUMN IF NOT EXISTS bus_confirmed BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN trips.bus_confirmed IS
    'FALSE: the bus is only planned (sets the seat type tickets are sold on); confirmed at departure in Bus & crew.';

COMMIT;
