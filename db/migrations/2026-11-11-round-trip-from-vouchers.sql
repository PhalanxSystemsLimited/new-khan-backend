-- Phase 2: round trip reports filled in from the trips and their terminal vouchers.
--   * A report leg can point at the real trip (round_trip_legs.trip_id); a trip is in at most one report.
--   * A report row can be copied from a terminal voucher (terminal_vouchers.trip_voucher_id). Such a row shows the
--     voucher's own number, so it takes NO new number from the series; rows typed in by hand still get one.
--   * edited_after_sync marks a copied row an admin changed by hand ("Update from vouchers" leaves it alone).
-- Only adds columns, indexes and a trigger function; existing reports and vouchers are unchanged. Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-11-round-trip-from-vouchers.sql   (or the Supabase SQL Editor)
BEGIN;

ALTER TABLE round_trip_legs ADD COLUMN IF NOT EXISTS trip_id BIGINT REFERENCES trips(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS round_trip_legs_trip_uq ON round_trip_legs (trip_id) WHERE trip_id IS NOT NULL;

ALTER TABLE terminal_vouchers ADD COLUMN IF NOT EXISTS trip_voucher_id BIGINT REFERENCES trip_vouchers(id) ON DELETE RESTRICT;
ALTER TABLE terminal_vouchers ADD COLUMN IF NOT EXISTS synced_at TIMESTAMPTZ;
ALTER TABLE terminal_vouchers ADD COLUMN IF NOT EXISTS edited_after_sync BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX IF NOT EXISTS terminal_vouchers_trip_voucher_uq ON terminal_vouchers (trip_voucher_id) WHERE trip_voucher_id IS NOT NULL;

-- A copied row has no number of its own (it shows its terminal voucher's number).
ALTER TABLE terminal_vouchers ALTER COLUMN voucher_no DROP NOT NULL;
ALTER TABLE terminal_vouchers DROP CONSTRAINT IF EXISTS terminal_vouchers_no_or_link;
ALTER TABLE terminal_vouchers ADD CONSTRAINT terminal_vouchers_no_or_link CHECK (voucher_no IS NOT NULL OR trip_voucher_id IS NOT NULL);

CREATE OR REPLACE FUNCTION set_report_voucher_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.trip_voucher_id IS NULL THEN
        NEW.voucher_no := next_voucher_no();   -- typed in by hand: its own number from the series
    ELSE
        NEW.voucher_no := NULL;                -- copied from a terminal voucher: uses that voucher's number
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION set_report_voucher_no() FROM anon, authenticated, public;
DROP TRIGGER IF EXISTS terminal_vouchers_set_no ON terminal_vouchers;
CREATE TRIGGER terminal_vouchers_set_no BEFORE INSERT ON terminal_vouchers FOR EACH ROW EXECUTE FUNCTION set_report_voucher_no();

COMMIT;
