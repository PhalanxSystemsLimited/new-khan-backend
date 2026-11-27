-- 2026-11-27: stay time at a stop (the route form now follows the route-alignment sheet).
--
-- route_stops.minutes_from_origin is the time the bus LEAVES the stop (passengers board then).
-- route_stops.stay_minutes is how long the bus waits there, so it ARRIVES at minutes_from_origin - stay_minutes
-- (passengers getting off there are dropped then). First and last stops have no stay.
--
-- Every stop that already exists gets 0, so nothing changes for existing routes.
-- Only adds a column; safe to run more than once.
-- Run it BEFORE deploying the backend that reads it: the Supabase SQL Editor
-- (or node scripts/run-sql.js db/migrations/2026-11-27-stop-stay-time.sql)
BEGIN;

ALTER TABLE route_stops ADD COLUMN IF NOT EXISTS stay_minutes SMALLINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'route_stops_stay_valid') THEN
    ALTER TABLE route_stops ADD CONSTRAINT route_stops_stay_valid
      CHECK (stay_minutes >= 0 AND stay_minutes <= minutes_from_origin);
  END IF;
END $$;

COMMENT ON COLUMN route_stops.minutes_from_origin IS
    'Minutes from the first stop to when the bus LEAVES this stop (boarding time).';
COMMENT ON COLUMN route_stops.stay_minutes IS
    'Minutes the bus waits at this stop: it arrives at minutes_from_origin - stay_minutes (dropping time).';

COMMIT;
