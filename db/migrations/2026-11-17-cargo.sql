-- 2026-11-17: Cargo (parcels sent on the buses), stage 1 part 1: settings, rates, booking a parcel, its history.
--
--  1. cargo_settings: one row. Compensation rules and not-allowed items (printed on every parcel slip, written by an
--     admin), how many days before an uncollected parcel counts as overdue, and whether counter staff may change
--     the charge worked out from the rate table.
--  2. cargo_rates: per city pair (from -> to): rate per kg, rate per piece, minimum charge.
--       charge = the higher of (weight x per kg) and (pieces x per piece), never below the minimum.
--  3. cargo_counter + next_parcel_no(): parcel numbers CG-0000001, CG-0000002 ... made by the database (like
--     voucher numbers): never typed, never changed, never reused. The counter row stays locked until the booking's
--     transaction ends, so two bookings can never get the same number.
--  4. parcels: one row per parcel (consignment): from / to terminal, sender (CNIC required), receiver, what it is,
--     pieces, weight, the rate-table charge and the charge actually taken (with the reason when lower), paid now
--     or "receiver pays on collection", and where it is: booked -> loaded -> arrived -> delivered (or returned /
--     cancelled).
--  5. parcel_events: the parcel's history (what happened, at which terminal, who, when).
--
-- Only adds tables and functions; nothing existing changes. Safe to run more than once.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-17-cargo.sql)
BEGIN;

-- 1. Settings (one row)
CREATE TABLE IF NOT EXISTS cargo_settings (
    id                       SMALLINT PRIMARY KEY CHECK (id = 1),
    rules_text               TEXT NOT NULL DEFAULT '',            -- compensation rules, printed on the slip
    not_allowed_text         TEXT NOT NULL DEFAULT '',            -- items not accepted, printed on the slip
    overdue_days             SMALLINT NOT NULL DEFAULT 7 CHECK (overdue_days BETWEEN 1 AND 90),
    staff_can_change_charge  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO cargo_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 2. Rates per city pair
CREATE TABLE IF NOT EXISTS cargo_rates (
    id            SERIAL PRIMARY KEY,
    from_city_id  INT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    to_city_id    INT NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    per_kg        INT NOT NULL DEFAULT 0 CHECK (per_kg >= 0),
    per_piece     INT NOT NULL DEFAULT 0 CHECK (per_piece >= 0),
    minimum       INT NOT NULL DEFAULT 0 CHECK (minimum >= 0),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cargo_rates_pair_uq UNIQUE (from_city_id, to_city_id),
    CONSTRAINT cargo_rates_cities_differ CHECK (from_city_id <> to_city_id)
);
DROP TRIGGER IF EXISTS cargo_rates_set_updated_at ON cargo_rates;
CREATE TRIGGER cargo_rates_set_updated_at BEFORE UPDATE ON cargo_rates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3. Parcel numbers
CREATE TABLE IF NOT EXISTS cargo_counter (
    id              SMALLINT PRIMARY KEY CHECK (id = 1),
    last_parcel_no  BIGINT NOT NULL DEFAULT 0 CHECK (last_parcel_no < 99999999),
    last_list_no    BIGINT NOT NULL DEFAULT 0 CHECK (last_list_no < 99999999)   -- bus cargo lists (part 2)
);
INSERT INTO cargo_counter (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION next_parcel_no()
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = public AS $$
    UPDATE cargo_counter SET last_parcel_no = last_parcel_no + 1 WHERE id = 1
    RETURNING 'CG-' || lpad(last_parcel_no::TEXT, 7, '0');
$$;

-- 4. Parcels
CREATE TABLE IF NOT EXISTS parcels (
    id                 BIGSERIAL PRIMARY KEY,
    parcel_no          VARCHAR(12) NOT NULL,
    from_terminal_id   INT NOT NULL REFERENCES terminals(id) ON DELETE RESTRICT,
    to_terminal_id     INT NOT NULL REFERENCES terminals(id) ON DELETE RESTRICT,
    sender_name        VARCHAR(120) NOT NULL,
    sender_phone       VARCHAR(20) NOT NULL,
    sender_cnic        VARCHAR(15) NOT NULL,
    receiver_name      VARCHAR(120) NOT NULL,
    receiver_phone     VARCHAR(20) NOT NULL,
    receiver_cnic      VARCHAR(15),
    description        VARCHAR(200) NOT NULL,
    pieces             SMALLINT NOT NULL CHECK (pieces BETWEEN 1 AND 500),
    weight_kg          NUMERIC(8, 2) NOT NULL CHECK (weight_kg > 0 AND weight_kg <= 10000),
    declared_value     INT CHECK (declared_value >= 0),
    calculated_charge  INT CHECK (calculated_charge >= 0),        -- from the rate table (NULL: no rate for this route)
    charge             INT NOT NULL CHECK (charge >= 0),          -- what the customer pays
    charge_note        VARCHAR(300),                              -- why the charge differs from the rate table
    payment            VARCHAR(10) NOT NULL CHECK (payment IN ('paid', 'to_pay')),
    paid_at            TIMESTAMPTZ,                               -- 'paid': at booking; 'to_pay': when collected
    paid_terminal_id   INT REFERENCES terminals(id) ON DELETE SET NULL,
    status             VARCHAR(12) NOT NULL DEFAULT 'booked'
                       CHECK (status IN ('booked', 'loaded', 'arrived', 'delivered', 'returned', 'cancelled')),
    booked_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    booked_by_name     VARCHAR(120) NOT NULL,
    cancelled_reason   VARCHAR(300),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT parcels_no_uq UNIQUE (parcel_no),
    CONSTRAINT parcels_no_format CHECK (parcel_no ~ '^CG-[0-9]{7,8}$'),
    CONSTRAINT parcels_terminals_differ CHECK (from_terminal_id <> to_terminal_id),
    CONSTRAINT parcels_paid_has_time CHECK (payment <> 'paid' OR paid_at IS NOT NULL),
    CONSTRAINT parcels_cancel_has_reason CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS parcels_created_idx ON parcels (created_at DESC);
CREATE INDEX IF NOT EXISTS parcels_from_idx ON parcels (from_terminal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS parcels_to_idx ON parcels (to_terminal_id, status);
CREATE INDEX IF NOT EXISTS parcels_sender_phone_idx ON parcels (sender_phone);
CREATE INDEX IF NOT EXISTS parcels_receiver_phone_idx ON parcels (receiver_phone);

CREATE OR REPLACE FUNCTION set_parcel_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.parcel_no := next_parcel_no();   -- always system-generated, whatever the insert says
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS parcels_set_no ON parcels;
CREATE TRIGGER parcels_set_no BEFORE INSERT ON parcels FOR EACH ROW EXECUTE FUNCTION set_parcel_no();

CREATE OR REPLACE FUNCTION keep_parcel_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.parcel_no IS DISTINCT FROM OLD.parcel_no THEN
        RAISE EXCEPTION 'A parcel number cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS parcels_keep_no ON parcels;
CREATE TRIGGER parcels_keep_no BEFORE UPDATE OF parcel_no ON parcels FOR EACH ROW EXECUTE FUNCTION keep_parcel_no();
DROP TRIGGER IF EXISTS parcels_set_updated_at ON parcels;
CREATE TRIGGER parcels_set_updated_at BEFORE UPDATE ON parcels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 5. History
CREATE TABLE IF NOT EXISTS parcel_events (
    id           BIGSERIAL PRIMARY KEY,
    parcel_id    BIGINT NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    event        VARCHAR(20) NOT NULL,          -- booked | cancelled (later: loaded | arrived | delivered | returned)
    terminal_id  INT REFERENCES terminals(id) ON DELETE SET NULL,
    note         VARCHAR(300),
    by_user      UUID REFERENCES users(id) ON DELETE SET NULL,
    by_name      VARCHAR(120) NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS parcel_events_parcel_idx ON parcel_events (parcel_id, created_at);

-- Server-only tables: never readable through Supabase's public API.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['cargo_settings','cargo_rates','cargo_counter','parcels','parcel_events'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION next_parcel_no() FROM anon, authenticated, public;

COMMIT;
