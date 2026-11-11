-- Phase 1: roles, conductors, terminal vouchers generated at each terminal.
--   * New login roles: manager, conductor. Counter staff ('agent') are tied to a terminal (users.terminal_id).
--   * Conductors (with an optional login) and a staff directory (cleaners, loaders... no login).
--   * Trips get a conductor (and an optional stand-in staff member). The old co-driver column is kept, unused.
--   * trip_vouchers: made by counter staff with "Generate voucher" at each terminal. 10-digit number from the same
--     company-wide series as the report vouchers (next_voucher_no), frozen once made. A generated voucher closes
--     booking from that terminal. Replacement (bus swap) needs a manager or admin; a cancelled trip voids them.
--   * terminal_deductions: fixed amounts per terminal (Adda, loader, cleaner...), copied onto each voucher.
--   * Road passengers booked by the conductor: booking channel 'on_road', tickets.is_free; no-show notes.
--   * E-tag / toll tax stops being an automatic off-route line (entered by hand after the trip).
-- Only adds (plus switching off the E-tag default). Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-10-terminal-vouchers-conductors.sql   (or the Supabase SQL Editor)

-- New enum values must be committed before anything uses them, so they come first, outside the transaction.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'manager' BEFORE 'admin';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'conductor' BEFORE 'manager';
ALTER TYPE booking_channel ADD VALUE IF NOT EXISTS 'on_road';

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Staff tied to a terminal
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS terminal_id INT REFERENCES terminals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_terminal_idx ON users (terminal_id) WHERE terminal_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Conductors and the staff directory
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conductors (
    id          SERIAL PRIMARY KEY,
    full_name   VARCHAR(120) NOT NULL,
    phone       VARCHAR(20)  NOT NULL,
    cnic        VARCHAR(15),
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,   -- the conductor's login account
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conductors_cnic_uq ON conductors (cnic) WHERE cnic IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conductors_user_uq ON conductors (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS staff_directory (             -- people who work but do not sign in
    id          SERIAL PRIMARY KEY,
    full_name   VARCHAR(120) NOT NULL,
    phone       VARCHAR(20),
    cnic        VARCHAR(15),
    job         VARCHAR(20) NOT NULL DEFAULT 'other',
    terminal_id INT REFERENCES terminals(id) ON DELETE SET NULL,
    notes       VARCHAR(300),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT staff_directory_job_valid CHECK (job IN ('cleaner', 'loader', 'helper', 'guard', 'other'))
);

ALTER TABLE trips ADD COLUMN IF NOT EXISTS conductor_id INT REFERENCES conductors(id) ON DELETE SET NULL;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS stand_in_conductor_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS trips_conductor_idx ON trips (conductor_id, departure_at) WHERE conductor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS trips_stand_in_idx ON trips (stand_in_conductor_id) WHERE stand_in_conductor_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Road passengers and no-shows
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_free BOOLEAN NOT NULL DEFAULT FALSE;      -- travelled free
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS no_show_note VARCHAR(300);                   -- e.g. "did not travel"
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES users(id) ON DELETE SET NULL; -- conductor

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Fixed deductions per terminal (names come from the on-route list: Adda, loader, cleaner...)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS terminal_deductions (
    id           SERIAL PRIMARY KEY,
    terminal_id  INT NOT NULL REFERENCES terminals(id) ON DELETE CASCADE,
    category_id  INT NOT NULL REFERENCES onroute_categories(id) ON DELETE CASCADE,
    amount       INT NOT NULL DEFAULT 0 CHECK (amount >= 0),
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT terminal_deductions_uq UNIQUE (terminal_id, category_id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Trip vouchers, generated at each terminal
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trip_vouchers (
    id                 BIGSERIAL PRIMARY KEY,
    voucher_no         VARCHAR(10) NOT NULL,
    trip_id            BIGINT NOT NULL REFERENCES trips(id) ON DELETE RESTRICT,
    boarding_stop_id   INT NOT NULL REFERENCES route_stops(id) ON DELETE RESTRICT,
    terminal_id        INT REFERENCES terminals(id) ON DELETE SET NULL,
    status             VARCHAR(10) NOT NULL DEFAULT 'generated',
    -- what was printed (frozen)
    terminal_name      VARCHAR(120) NOT NULL,
    route_name         VARCHAR(150) NOT NULL,
    bus_id             INT REFERENCES buses(id) ON DELETE SET NULL,
    bus_no             VARCHAR(20) NOT NULL,
    driver_name        VARCHAR(120),
    conductor_name     VARCHAR(120),
    departure_at       TIMESTAMPTZ NOT NULL,                   -- this terminal's departure time
    seats_boarding     INT NOT NULL DEFAULT 0,                 -- paid seats boarding at this terminal
    fare_boarding      INT NOT NULL DEFAULT 0,
    on_board           INT NOT NULL DEFAULT 0,                 -- everyone on the bus after this terminal
    free_on_board      INT NOT NULL DEFAULT 0,
    terminal_cash      INT NOT NULL DEFAULT 0,                 -- paid in cash at the counter
    online_paid        INT NOT NULL DEFAULT 0,                 -- paid online (not in the conductor's hand)
    load_amount        INT NOT NULL DEFAULT 0 CHECK (load_amount >= 0),
    cargo_amount       INT NOT NULL DEFAULT 0 CHECK (cargo_amount >= 0),
    deductions_total   INT NOT NULL DEFAULT 0,
    cash_to_conductor  INT NOT NULL DEFAULT 0,                 -- terminal cash + load + cargo - deductions
    generated_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    generated_by_name  VARCHAR(120) NOT NULL,
    generated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- replacement / void
    replaces_id        BIGINT REFERENCES trip_vouchers(id) ON DELETE SET NULL,
    replace_reason     VARCHAR(300),
    approved_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by_name   VARCHAR(120),
    closed_at          TIMESTAMPTZ,                            -- when it was replaced or voided
    closed_reason      VARCHAR(300),
    CONSTRAINT trip_vouchers_no_uq UNIQUE (voucher_no),
    CONSTRAINT trip_vouchers_no_format CHECK (voucher_no ~ '^[0-9]{10}$'),
    CONSTRAINT trip_vouchers_status_valid CHECK (status IN ('generated', 'replaced', 'void'))
);
-- One live voucher per trip per terminal.
CREATE UNIQUE INDEX IF NOT EXISTS trip_vouchers_live_uq ON trip_vouchers (trip_id, boarding_stop_id) WHERE status = 'generated';
CREATE INDEX IF NOT EXISTS trip_vouchers_trip_idx ON trip_vouchers (trip_id, generated_at);
CREATE INDEX IF NOT EXISTS trip_vouchers_generated_idx ON trip_vouchers (generated_at DESC);

DROP TRIGGER IF EXISTS trip_vouchers_set_no ON trip_vouchers;
CREATE TRIGGER trip_vouchers_set_no BEFORE INSERT ON trip_vouchers FOR EACH ROW EXECUTE FUNCTION set_voucher_no();
DROP TRIGGER IF EXISTS trip_vouchers_keep_no ON trip_vouchers;
CREATE TRIGGER trip_vouchers_keep_no BEFORE UPDATE OF voucher_no ON trip_vouchers FOR EACH ROW EXECUTE FUNCTION keep_voucher_no();

-- Voucher numbers are unique across BOTH voucher tables (one series). The counter already guarantees it; this
-- trigger makes sure nothing can bypass it.
CREATE OR REPLACE FUNCTION voucher_no_not_in_other_table()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF TG_TABLE_NAME = 'trip_vouchers' AND EXISTS (SELECT 1 FROM terminal_vouchers WHERE voucher_no = NEW.voucher_no)
       OR TG_TABLE_NAME = 'terminal_vouchers' AND EXISTS (SELECT 1 FROM trip_vouchers WHERE voucher_no = NEW.voucher_no) THEN
        RAISE EXCEPTION 'Voucher number % is already used', NEW.voucher_no;
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trip_vouchers_no_unique_all ON trip_vouchers;
CREATE TRIGGER trip_vouchers_no_unique_all AFTER INSERT ON trip_vouchers FOR EACH ROW EXECUTE FUNCTION voucher_no_not_in_other_table();
DROP TRIGGER IF EXISTS terminal_vouchers_no_unique_all ON terminal_vouchers;
CREATE TRIGGER terminal_vouchers_no_unique_all AFTER INSERT ON terminal_vouchers FOR EACH ROW EXECUTE FUNCTION voucher_no_not_in_other_table();

CREATE TABLE IF NOT EXISTS trip_voucher_lines (          -- seats and fares per destination
    id                   BIGSERIAL PRIMARY KEY,
    voucher_id           BIGINT NOT NULL REFERENCES trip_vouchers(id) ON DELETE CASCADE,
    destination_stop_id  INT REFERENCES route_stops(id) ON DELETE SET NULL,
    destination          VARCHAR(120) NOT NULL,
    seats                INT NOT NULL CHECK (seats >= 0),
    free_seats           INT NOT NULL DEFAULT 0 CHECK (free_seats >= 0),
    fare                 INT NOT NULL CHECK (fare >= 0),
    sort_order           SMALLINT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS trip_voucher_lines_voucher_idx ON trip_voucher_lines (voucher_id, sort_order);

CREATE TABLE IF NOT EXISTS trip_voucher_deductions (
    id           BIGSERIAL PRIMARY KEY,
    voucher_id   BIGINT NOT NULL REFERENCES trip_vouchers(id) ON DELETE CASCADE,
    category_id  INT REFERENCES onroute_categories(id) ON DELETE SET NULL,
    name         VARCHAR(60) NOT NULL,
    amount       INT NOT NULL CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS trip_voucher_deductions_voucher_idx ON trip_voucher_deductions (voucher_id);

CREATE TABLE IF NOT EXISTS trip_voucher_passengers (     -- the passengers linked to the voucher when it was made
    id           BIGSERIAL PRIMARY KEY,
    voucher_id   BIGINT NOT NULL REFERENCES trip_vouchers(id) ON DELETE CASCADE,
    ticket_id    UUID REFERENCES tickets(id) ON DELETE SET NULL,
    seat_number  VARCHAR(6) NOT NULL,
    name         VARCHAR(120) NOT NULL,
    gender       VARCHAR(6),
    destination  VARCHAR(120) NOT NULL,
    fare         INT NOT NULL DEFAULT 0,
    paid_by      VARCHAR(20),
    is_free      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS trip_voucher_passengers_voucher_idx ON trip_voucher_passengers (voucher_id);

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Security: only the backend (table owner) reads and writes these tables.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['conductors','staff_directory','terminal_deductions','trip_vouchers','trip_voucher_lines',
                             'trip_voucher_deductions','trip_voucher_passengers']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION voucher_no_not_in_other_table() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS conductors_set_updated_at ON conductors;
CREATE TRIGGER conductors_set_updated_at BEFORE UPDATE ON conductors FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS staff_directory_set_updated_at ON staff_directory;
CREATE TRIGGER staff_directory_set_updated_at BEFORE UPDATE ON staff_directory FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Starting lists
-- ---------------------------------------------------------------------------------------------------------------
-- Deduction names used by terminals (added to the on-route list if missing).
INSERT INTO onroute_categories (name, sort_order) VALUES ('Loader', 7), ('Cleaner', 8)
ON CONFLICT DO NOTHING;

-- E-tag / toll tax is entered by hand after the trip (meeting, 33): no longer an automatic off-route line.
UPDATE offroute_categories SET is_active = FALSE WHERE lower(name) = 'e-tag / toll tax' AND is_active;

COMMIT;
