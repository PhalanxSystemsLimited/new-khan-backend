-- 2026-11-18: Cargo, stage 1 part 2: bus cargo lists (the "header list" in the meeting notes).
--
--  1. cargo_lists: the parcels one bus carries from one terminal: one list per trip per terminal, like vouchers.
--     Numbers CL-000001, CL-000002 ... made by the database (never typed, changed or reused).
--       open    staff add / remove parcels booked at that terminal (by number or by scanning the slip)
--       closed  the terminal generated its voucher: the voucher's Cargo amount is the list's paid total, the list's
--               totals are frozen, and its parcels are "loaded" (on the bus)
--       void    the trip was cancelled (its parcels go back to "booked" at the terminal), or the list was empty when
--               the voucher was generated
--  2. parcels.list_id: the list a parcel is on (none while it waits at the terminal).
--
-- Only adds a table, a column and functions; nothing existing changes. Needs 2026-11-17-cargo.sql first.
-- Safe to run more than once.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-18-cargo-lists.sql)
BEGIN;

CREATE OR REPLACE FUNCTION next_cargo_list_no()
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = public AS $$
    UPDATE cargo_counter SET last_list_no = last_list_no + 1 WHERE id = 1
    RETURNING 'CL-' || lpad(last_list_no::TEXT, 6, '0');
$$;

CREATE TABLE IF NOT EXISTS cargo_lists (
    id                BIGSERIAL PRIMARY KEY,
    list_no           VARCHAR(12) NOT NULL,
    trip_id           BIGINT NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,
    boarding_stop_id  INT NOT NULL REFERENCES route_stops(id) ON DELETE RESTRICT,
    terminal_id       INT REFERENCES terminals(id) ON DELETE SET NULL,
    status            VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'void')),
    voucher_id        BIGINT REFERENCES trip_vouchers(id) ON DELETE SET NULL,
    -- frozen when the list closes (what the conductor's printed list shows)
    bus_no            VARCHAR(20),
    parcel_count      INT,
    receiver_count    INT,
    pieces            INT,
    weight_kg         NUMERIC(10, 2),
    paid_total        INT,
    to_pay_total      INT,
    created_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by_name   VARCHAR(120) NOT NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at         TIMESTAMPTZ,
    closed_by_name    VARCHAR(120),
    void_reason       VARCHAR(300),
    CONSTRAINT cargo_lists_no_uq UNIQUE (list_no),
    CONSTRAINT cargo_lists_no_format CHECK (list_no ~ '^CL-[0-9]{6,8}$'),
    CONSTRAINT cargo_lists_void_has_reason CHECK (status <> 'void' OR void_reason IS NOT NULL)
);
-- One live list per trip per terminal.
CREATE UNIQUE INDEX IF NOT EXISTS cargo_lists_live_uq ON cargo_lists (trip_id, boarding_stop_id) WHERE status <> 'void';
CREATE INDEX IF NOT EXISTS cargo_lists_created_idx ON cargo_lists (created_at DESC);
CREATE INDEX IF NOT EXISTS cargo_lists_voucher_idx ON cargo_lists (voucher_id) WHERE voucher_id IS NOT NULL;

CREATE OR REPLACE FUNCTION set_cargo_list_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.list_no := next_cargo_list_no();   -- always system-generated, whatever the insert says
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cargo_lists_set_no ON cargo_lists;
CREATE TRIGGER cargo_lists_set_no BEFORE INSERT ON cargo_lists FOR EACH ROW EXECUTE FUNCTION set_cargo_list_no();

CREATE OR REPLACE FUNCTION keep_cargo_list_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.list_no IS DISTINCT FROM OLD.list_no THEN
        RAISE EXCEPTION 'A cargo list number cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS cargo_lists_keep_no ON cargo_lists;
CREATE TRIGGER cargo_lists_keep_no BEFORE UPDATE OF list_no ON cargo_lists FOR EACH ROW EXECUTE FUNCTION keep_cargo_list_no();

ALTER TABLE parcels ADD COLUMN IF NOT EXISTS list_id BIGINT REFERENCES cargo_lists(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS parcels_list_idx ON parcels (list_id) WHERE list_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS parcels_waiting_idx ON parcels (from_terminal_id) WHERE status = 'booked' AND list_id IS NULL;

-- Server-only: never readable through Supabase's public API.
ALTER TABLE cargo_lists ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON cargo_lists FROM anon, authenticated;
REVOKE ALL ON FUNCTION next_cargo_list_no() FROM anon, authenticated, public;

COMMIT;
