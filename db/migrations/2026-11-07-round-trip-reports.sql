-- Round Trip Report: the income and expense sheet for one bus's round trip (e.g. Lahore -> DIK -> Lahore).
--   * A round trip has legs; each leg has one terminal voucher per terminal (one row of the sales table).
--   * Every voucher gets a globally unique 10-digit number (counter row, locked per insert: no duplicates, no gaps)
--     and a QR token that opens the live report. Tokens are random (128 bit) and can be revoked.
--   * Diesel is entered by an admin (fuel entries). On-route expenses and online sales are entered per voucher.
--   * Off-route expenses come from admin-managed defaults (per route, falling back to a global default) and are
--     COPIED onto the round trip when it is created, so later changes to the defaults never alter a report.
-- Only adds tables, columns and seed rows. Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-07-round-trip-reports.sql   (or paste into the Supabase SQL Editor)
BEGIN;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Lists managed in the admin panel
-- ---------------------------------------------------------------------------------------------------------------
ALTER TABLE buses ADD COLUMN IF NOT EXISTS has_hostess BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS onroute_categories (          -- Adda, TMA, Welfare ... (entered per voucher)
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS onroute_categories_name_uq ON onroute_categories (lower(name));

CREATE TABLE IF NOT EXISTS online_platforms (            -- Web app, Bookme, Bookkaro ...
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS online_platforms_name_uq ON online_platforms (lower(name));

CREATE TABLE IF NOT EXISTS offroute_categories (         -- Daily driver, E-tag / toll tax ...
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(80) NOT NULL,
    sort_order       SMALLINT NOT NULL DEFAULT 0,
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,     -- deactivated, never deleted
    requires_hostess BOOLEAN NOT NULL DEFAULT FALSE,    -- only on buses that carry a hostess
    bus_classes      bus_class[] NOT NULL DEFAULT '{}', -- empty = every bus class
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS offroute_categories_name_uq ON offroute_categories (lower(name));

-- One row per category for the global default (route_id NULL) and one per route that differs.
-- is_enabled = FALSE on a route row switches the category off for that route.
CREATE TABLE IF NOT EXISTS offroute_defaults (
    id           SERIAL PRIMARY KEY,
    category_id  INT NOT NULL REFERENCES offroute_categories(id) ON DELETE CASCADE,
    route_id     INT REFERENCES routes(id) ON DELETE CASCADE,
    amount       INT NOT NULL DEFAULT 0 CHECK (amount >= 0),
    is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT offroute_defaults_uq UNIQUE NULLS NOT DISTINCT (category_id, route_id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Round trips
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS round_trips (
    id                  BIGSERIAL PRIMARY KEY,                -- the "Report ID"
    route_id            INT REFERENCES routes(id) ON DELETE SET NULL,  -- picks the off-route defaults
    bus_id              INT NOT NULL REFERENCES buses(id),
    driver_id           INT REFERENCES drivers(id) ON DELETE SET NULL,
    driver_name         VARCHAR(120),                         -- as printed (taken from the driver when blank)
    fare_collector      VARCHAR(120),
    route_label         VARCHAR(120) NOT NULL,                -- e.g. LHR ⇄ DIK via MWL
    report_date         DATE NOT NULL,
    report_time         TIME,
    distance_km         NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (distance_km >= 0),
    mobil_oil           NUMERIC(8,2) NOT NULL DEFAULT 0 CHECK (mobil_oil >= 0),
    other_expense       INT NOT NULL DEFAULT 0 CHECK (other_expense >= 0),
    other_expense_note  VARCHAR(200),
    other_income        INT NOT NULL DEFAULT 0 CHECK (other_income >= 0),
    other_income_note   VARCHAR(200),
    cashier_name        VARCHAR(120),
    cash_received_at    TIMESTAMPTZ,
    incharge_name       VARCHAR(120),
    status              VARCHAR(10) NOT NULL DEFAULT 'draft',
    finalized_at        TIMESTAMPTZ,
    finalized_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),   -- "last updated" on the report: bumped on every edit
    CONSTRAINT round_trips_status_valid CHECK (status IN ('draft', 'finalized')),
    CONSTRAINT round_trips_finalized_has_time CHECK (status = 'draft' OR finalized_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS round_trips_date_idx ON round_trips (report_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS round_trips_bus_idx ON round_trips (bus_id, report_date DESC);

CREATE TABLE IF NOT EXISTS round_trip_legs (
    id             BIGSERIAL PRIMARY KEY,
    round_trip_id  BIGINT NOT NULL REFERENCES round_trips(id) ON DELETE CASCADE,
    leg_no         SMALLINT NOT NULL CHECK (leg_no > 0),
    title          VARCHAR(150) NOT NULL,                     -- e.g. Lahore to DIK via Mianwali
    leg_ref        VARCHAR(40),                               -- optional leg-level paper reference number
    CONSTRAINT round_trip_legs_no_uq UNIQUE (round_trip_id, leg_no)
);

CREATE TABLE IF NOT EXISTS round_trip_fuel_entries (
    id             BIGSERIAL PRIMARY KEY,
    round_trip_id  BIGINT NOT NULL REFERENCES round_trips(id) ON DELETE CASCADE,
    sort_order     SMALLINT NOT NULL DEFAULT 0,
    station        VARCHAR(30) NOT NULL,                      -- e.g. LHR
    litres         NUMERIC(10,3) NOT NULL CHECK (litres > 0),
    rate           NUMERIC(10,3) NOT NULL CHECK (rate >= 0),  -- per litre
    amount         INT NOT NULL CHECK (amount >= 0)           -- billed amount; prefilled as round(litres x rate)
);
CREATE INDEX IF NOT EXISTS round_trip_fuel_trip_idx ON round_trip_fuel_entries (round_trip_id, sort_order);

-- The trip's own copy of each off-route line, made when the trip is created.
CREATE TABLE IF NOT EXISTS round_trip_offroute_lines (
    id              BIGSERIAL PRIMARY KEY,
    round_trip_id   BIGINT NOT NULL REFERENCES round_trips(id) ON DELETE CASCADE,
    category_id     INT REFERENCES offroute_categories(id) ON DELETE SET NULL,
    name            VARCHAR(80) NOT NULL,
    amount          INT NOT NULL CHECK (amount >= 0),
    default_amount  INT NOT NULL CHECK (default_amount >= 0), -- the default when copied
    sort_order      SMALLINT NOT NULL DEFAULT 0,
    is_overridden   BOOLEAN NOT NULL DEFAULT FALSE,
    overridden_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    overridden_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS round_trip_offroute_trip_idx ON round_trip_offroute_lines (round_trip_id, sort_order);

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Terminal vouchers (one row of the sales table each)
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voucher_counter (
    id       SMALLINT PRIMARY KEY CHECK (id = 1),
    last_no  BIGINT NOT NULL CHECK (last_no < 9999999999)
);
INSERT INTO voucher_counter (id, last_no) VALUES (1, 1000000000) ON CONFLICT (id) DO NOTHING;

/** Next voucher number. The counter row stays locked until the inserting transaction ends, so two requests
    can never get the same number, and a rolled-back insert gives its number back (no gaps). */
CREATE OR REPLACE FUNCTION next_voucher_no()
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = public AS $$
    UPDATE voucher_counter SET last_no = last_no + 1 WHERE id = 1 RETURNING lpad(last_no::TEXT, 10, '0');
$$;

CREATE TABLE IF NOT EXISTS terminal_vouchers (
    id             BIGSERIAL PRIMARY KEY,
    voucher_no     VARCHAR(10) NOT NULL,
    round_trip_id  BIGINT NOT NULL REFERENCES round_trips(id) ON DELETE CASCADE,
    leg_id         BIGINT NOT NULL REFERENCES round_trip_legs(id) ON DELETE CASCADE,
    sort_order     SMALLINT NOT NULL DEFAULT 0,
    terminal_id    INT REFERENCES terminals(id) ON DELETE SET NULL,
    terminal_name  VARCHAR(120) NOT NULL,                     -- as printed
    departure_at   TIMESTAMPTZ,
    pax_terminal   INT NOT NULL DEFAULT 0 CHECK (pax_terminal >= 0),
    pax_enroute    INT NOT NULL DEFAULT 0 CHECK (pax_enroute >= 0),
    inc_terminal   INT NOT NULL DEFAULT 0 CHECK (inc_terminal >= 0),
    inc_enroute    INT NOT NULL DEFAULT 0 CHECK (inc_enroute >= 0),
    load_amount    INT NOT NULL DEFAULT 0 CHECK (load_amount >= 0),
    cargo_amount   INT NOT NULL DEFAULT 0 CHECK (cargo_amount >= 0),
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT terminal_vouchers_no_uq UNIQUE (voucher_no),
    CONSTRAINT terminal_vouchers_no_format CHECK (voucher_no ~ '^[0-9]{10}$')
);
CREATE INDEX IF NOT EXISTS terminal_vouchers_trip_idx ON terminal_vouchers (round_trip_id, leg_id, sort_order);

CREATE OR REPLACE FUNCTION set_voucher_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.voucher_no := next_voucher_no();   -- always system-generated, whatever the insert says
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS terminal_vouchers_set_no ON terminal_vouchers;
CREATE TRIGGER terminal_vouchers_set_no BEFORE INSERT ON terminal_vouchers
    FOR EACH ROW EXECUTE FUNCTION set_voucher_no();

CREATE OR REPLACE FUNCTION keep_voucher_no()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.voucher_no IS DISTINCT FROM OLD.voucher_no THEN
        RAISE EXCEPTION 'A voucher number cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS terminal_vouchers_keep_no ON terminal_vouchers;
CREATE TRIGGER terminal_vouchers_keep_no BEFORE UPDATE OF voucher_no ON terminal_vouchers
    FOR EACH ROW EXECUTE FUNCTION keep_voucher_no();

CREATE TABLE IF NOT EXISTS voucher_onroute_lines (
    id           BIGSERIAL PRIMARY KEY,
    voucher_id   BIGINT NOT NULL REFERENCES terminal_vouchers(id) ON DELETE CASCADE,
    category_id  INT REFERENCES onroute_categories(id) ON DELETE SET NULL,
    name         VARCHAR(60) NOT NULL,
    amount       INT NOT NULL CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS voucher_onroute_voucher_idx ON voucher_onroute_lines (voucher_id);

CREATE TABLE IF NOT EXISTS voucher_online_sales (
    id             BIGSERIAL PRIMARY KEY,
    voucher_id     BIGINT NOT NULL REFERENCES terminal_vouchers(id) ON DELETE CASCADE,
    platform_id    INT REFERENCES online_platforms(id) ON DELETE SET NULL,
    platform_name  VARCHAR(60) NOT NULL,
    seats          INT NOT NULL DEFAULT 0 CHECK (seats >= 0),
    amount         INT NOT NULL CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS voucher_online_voucher_idx ON voucher_online_sales (voucher_id);

-- ---------------------------------------------------------------------------------------------------------------
-- 4. QR tokens (one live token per voucher, plus one for the report header) and scans
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS report_tokens (
    id             BIGSERIAL PRIMARY KEY,
    token          VARCHAR(32) NOT NULL,                       -- 128-bit random, base64url
    round_trip_id  BIGINT NOT NULL REFERENCES round_trips(id) ON DELETE CASCADE,
    voucher_id     BIGINT REFERENCES terminal_vouchers(id) ON DELETE CASCADE,  -- NULL = report header QR
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at     TIMESTAMPTZ,
    revoked_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT report_tokens_token_uq UNIQUE (token),
    CONSTRAINT report_tokens_token_format CHECK (token ~ '^[A-Za-z0-9_-]{22,32}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS report_tokens_live_voucher_uq ON report_tokens (voucher_id)
    WHERE revoked_at IS NULL AND voucher_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS report_tokens_live_report_uq ON report_tokens (round_trip_id)
    WHERE revoked_at IS NULL AND voucher_id IS NULL;

CREATE TABLE IF NOT EXISTS report_scans (
    id             BIGSERIAL PRIMARY KEY,
    token_id       BIGINT NOT NULL REFERENCES report_tokens(id) ON DELETE CASCADE,
    round_trip_id  BIGINT NOT NULL REFERENCES round_trips(id) ON DELETE CASCADE,
    voucher_id     BIGINT REFERENCES terminal_vouchers(id) ON DELETE SET NULL,
    user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    ip_address     INET,
    scanned_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS report_scans_trip_idx ON report_scans (round_trip_id, scanned_at DESC);

-- ---------------------------------------------------------------------------------------------------------------
-- 5. Security: the backend connects as the table owner; the browser (anon/authenticated) gets nothing.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['onroute_categories','online_platforms','offroute_categories','offroute_defaults',
        'round_trips','round_trip_legs','round_trip_fuel_entries','round_trip_offroute_lines','voucher_counter',
        'terminal_vouchers','voucher_onroute_lines','voucher_online_sales','report_tokens','report_scans']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION next_voucher_no() FROM anon, authenticated, public;

DROP TRIGGER IF EXISTS round_trips_set_updated_at ON round_trips;
CREATE TRIGGER round_trips_set_updated_at BEFORE UPDATE ON round_trips FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS offroute_categories_set_updated_at ON offroute_categories;
CREATE TRIGGER offroute_categories_set_updated_at BEFORE UPDATE ON offroute_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();
DROP TRIGGER IF EXISTS terminal_vouchers_set_updated_at ON terminal_vouchers;
CREATE TRIGGER terminal_vouchers_set_updated_at BEFORE UPDATE ON terminal_vouchers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Starting lists (from the paper samples). Existing rows are left alone; admins edit them in the panel.
-- ---------------------------------------------------------------------------------------------------------------
INSERT INTO onroute_categories (name, sort_order) VALUES
    ('Adda', 1), ('Booking clerk', 2), ('Howkery', 3), ('Manager', 4), ('TMA', 5), ('Welfare', 6)
ON CONFLICT DO NOTHING;

INSERT INTO online_platforms (name, sort_order) VALUES ('Web app', 1), ('Bookme', 2), ('Bookkaro', 3)
ON CONFLICT DO NOTHING;

INSERT INTO offroute_categories (name, sort_order, requires_hostess) VALUES
    ('Air cleaning', 1, FALSE), ('Cleaning / washing', 2, FALSE), ('Daily conductor', 3, FALSE),
    ('Daily driver', 4, FALSE), ('Daily hostess', 5, TRUE), ('E-tag / toll tax', 6, FALSE),
    ('Extra hawkery', 7, FALSE), ('Greasing', 8, FALSE), ('Incentives', 9, FALSE),
    ('Mechanic charges', 10, FALSE), ('Police daily expense', 11, FALSE), ('Tyre puncture etc.', 12, FALSE)
ON CONFLICT DO NOTHING;

-- Global defaults (used on every route without its own amount).
INSERT INTO offroute_defaults (category_id, route_id, amount)
SELECT c.id, NULL, v.amount
FROM (VALUES ('Air cleaning', 130), ('Cleaning / washing', 550), ('Daily conductor', 2000), ('Daily driver', 3000),
             ('Daily hostess', 500), ('E-tag / toll tax', 0), ('Extra hawkery', 500), ('Greasing', 130),
             ('Incentives', 3000), ('Mechanic charges', 500), ('Police daily expense', 100), ('Tyre puncture etc.', 100)
     ) AS v(name, amount)
JOIN offroute_categories c ON lower(c.name) = lower(v.name)
ON CONFLICT ON CONSTRAINT offroute_defaults_uq DO NOTHING;

-- DIK routes (Trip 24319 sample): Daily conductor 2,500, Daily driver 3,650, E-tag / toll tax 10,380.
INSERT INTO offroute_defaults (category_id, route_id, amount)
SELECT c.id, r.id, v.amount
FROM (VALUES ('Daily conductor', 2500), ('Daily driver', 3650), ('E-tag / toll tax', 10380)) AS v(name, amount)
JOIN offroute_categories c ON lower(c.name) = lower(v.name)
JOIN routes r ON r.code IN ('NK-LHR-DIK', 'NK-DIK-LHR')
ON CONFLICT ON CONSTRAINT offroute_defaults_uq DO NOTHING;

COMMIT;
