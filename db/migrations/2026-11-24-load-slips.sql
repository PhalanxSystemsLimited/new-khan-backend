-- 2026-11-24: Extra load slips (LD-000001 ...): a passenger's extra luggage, paid for and tied to their booking.
--
-- Counter staff (their own terminal) or a manager add a slip to a paid booking that boards at that terminal, until the
-- terminal's voucher is generated. That voucher's Load is then the total of those slips (no longer typed by hand) and
-- the slips are frozen on it (voucher_id). The trip's conductor can also add a slip on the road: that cash stays with
-- him, so it is not on a terminal voucher; it is counted in the round trip report at the stage where it was taken
-- (stop_id = the last terminal the bus left, like his road passengers).
-- Numbers come from a counter row (no gaps). A slip is never deleted: a mistake is cancelled with a reason.
--
-- Safe to run more than once. Nothing else changes.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-24-load-slips.sql)
BEGIN;

CREATE TABLE IF NOT EXISTS load_slip_counter (
    id       SMALLINT PRIMARY KEY CHECK (id = 1),
    last_no  BIGINT NOT NULL DEFAULT 0
);
INSERT INTO load_slip_counter (id, last_no) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION next_load_slip_no()
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = public AS $$
    UPDATE load_slip_counter SET last_no = last_no + 1 WHERE id = 1
    RETURNING 'LD-' || lpad(last_no::TEXT, 6, '0');
$$;

CREATE TABLE IF NOT EXISTS load_slips (
    id                 BIGSERIAL PRIMARY KEY,
    slip_no            VARCHAR(12) NOT NULL,
    booking_id         UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    trip_id            BIGINT NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,
    -- counter: the booking's boarding stop (its voucher takes the money) · conductor: the last terminal the bus left
    stop_id            INT NOT NULL REFERENCES route_stops(id) ON DELETE RESTRICT,
    taken_by           VARCHAR(10) NOT NULL CHECK (taken_by IN ('counter', 'conductor')),
    terminal_id        INT REFERENCES terminals(id) ON DELETE SET NULL,
    amount             INT NOT NULL CHECK (amount > 0 AND amount <= 100000),
    pieces             SMALLINT CHECK (pieces BETWEEN 1 AND 99),
    weight_kg          NUMERIC(6, 1) CHECK (weight_kg > 0 AND weight_kg <= 9999),
    note               VARCHAR(200),
    status             VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
    voucher_id         BIGINT REFERENCES trip_vouchers(id) ON DELETE SET NULL,   -- counter slips: the voucher that took the money
    created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_name    VARCHAR(120) NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at       TIMESTAMPTZ,
    cancelled_by_name  VARCHAR(120),
    cancel_reason      VARCHAR(300),
    CONSTRAINT load_slips_no_uq UNIQUE (slip_no),
    CONSTRAINT load_slips_no_format CHECK (slip_no ~ '^LD-[0-9]{6,9}$'),
    CONSTRAINT load_slips_cancel_has_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL),
    CONSTRAINT load_slips_conductor_no_voucher CHECK (taken_by = 'counter' OR voucher_id IS NULL)
);
CREATE INDEX IF NOT EXISTS load_slips_booking_idx ON load_slips (booking_id);
CREATE INDEX IF NOT EXISTS load_slips_trip_stop_idx ON load_slips (trip_id, stop_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS load_slips_voucher_idx ON load_slips (voucher_id) WHERE voucher_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_load_slip_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.slip_no := next_load_slip_no();   -- always system-generated, whatever the insert says
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS load_slips_set_no ON load_slips;
CREATE TRIGGER load_slips_set_no BEFORE INSERT ON load_slips FOR EACH ROW EXECUTE FUNCTION set_load_slip_no();

CREATE OR REPLACE FUNCTION keep_load_slip_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.slip_no IS DISTINCT FROM OLD.slip_no THEN
        RAISE EXCEPTION 'A load slip number cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS load_slips_keep_no ON load_slips;
CREATE TRIGGER load_slips_keep_no BEFORE UPDATE OF slip_no ON load_slips FOR EACH ROW EXECUTE FUNCTION keep_load_slip_no();

ALTER TABLE load_slip_counter ENABLE ROW LEVEL SECURITY;
ALTER TABLE load_slips ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON load_slip_counter FROM anon, authenticated;
REVOKE ALL ON load_slips FROM anon, authenticated;
REVOKE ALL ON FUNCTION next_load_slip_no() FROM anon, authenticated, public;

COMMIT;
