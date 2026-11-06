-- =====================================================================
--  New Khan Bus Service — Booking System
--  PostgreSQL schema for SUPABASE (Postgres 15+)
--
--  How to run:
--    * Supabase Dashboard -> SQL Editor -> New query -> paste and Run, or
--    * psql "<supabase session-pooler connection string>" -f schema.sql
--
--  Auth is handled by Supabase Auth (auth.users). public.users is the
--  profile table, created automatically by a trigger on signup.
--
--  SECURITY: Row Level Security is enabled on every table with NO policies,
--  and anon/authenticated roles are revoked. The Supabase REST API (anon key)
--  therefore cannot read or write any of this data. All access goes through
--  the Node.js backend, which connects as the postgres role.
--
--  The whole script runs in one transaction.
-- =====================================================================

BEGIN;


-- ---------------------------------------------------------------------
-- 1. ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE user_role        AS ENUM ('customer', 'agent', 'admin', 'super_admin');
CREATE TYPE bus_class        AS ENUM ('economy', 'executive', 'business', 'sleeper');
CREATE TYPE seat_kind        AS ENUM ('standard', 'window', 'aisle', 'sleeper', 'driver', 'blocked');
CREATE TYPE trip_status      AS ENUM ('scheduled', 'boarding', 'departed', 'arrived', 'cancelled', 'delayed');
CREATE TYPE booking_status   AS ENUM ('pending', 'confirmed', 'cancelled', 'completed', 'expired', 'refunded');
CREATE TYPE ticket_status    AS ENUM ('held', 'reserved', 'confirmed', 'boarded', 'cancelled', 'no_show');
CREATE TYPE payment_status   AS ENUM ('initiated', 'pending', 'succeeded', 'failed', 'refunded', 'partially_refunded');
CREATE TYPE payment_method   AS ENUM ('cash', 'card', 'jazzcash', 'easypaisa', 'bank_transfer', 'wallet');
CREATE TYPE refund_status    AS ENUM ('requested', 'approved', 'processed', 'rejected');
CREATE TYPE gender_type      AS ENUM ('male', 'female', 'other');
CREATE TYPE discount_type    AS ENUM ('percentage', 'fixed');
CREATE TYPE booking_channel  AS ENUM ('web', 'mobile_app', 'counter', 'phone', 'agent');

-- ---------------------------------------------------------------------
-- 2. HELPER: auto-maintain updated_at
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------
-- 3. USERS (profile linked 1:1 to Supabase auth.users)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name       VARCHAR(120) NOT NULL,
    email           VARCHAR(255),
    phone           VARCHAR(20),
    role            user_role    NOT NULL DEFAULT 'customer',
    cnic            VARCHAR(15),                  -- national ID, e.g. 35202-1234567-1
    gender          gender_type,
    date_of_birth   DATE,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    email_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
    phone_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT users_phone_format CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{10,15}$'),
    CONSTRAINT users_gender_mf CHECK (gender IS NULL OR gender IN ('male', 'female'))
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX users_phone_uq ON users (phone) WHERE phone IS NOT NULL;

-- Create / sync the profile whenever a Supabase auth user is created or changed.
-- Role is ALWAYS 'customer' on signup; user metadata can never grant a role.
CREATE OR REPLACE FUNCTION handle_auth_user_change()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_phone TEXT := CASE WHEN NEW.phone ~ '^\+?[0-9]{10,15}$' THEN NEW.phone ELSE NULL END;
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.users (id, full_name, email, phone, email_verified, phone_verified)
        VALUES (
            NEW.id,
            left(COALESCE(NULLIF(trim(NEW.raw_user_meta_data->>'full_name'), ''), 'Customer'), 120),
            NEW.email,
            v_phone,
            NEW.email_confirmed_at IS NOT NULL,
            NEW.phone_confirmed_at IS NOT NULL
        )
        ON CONFLICT (id) DO NOTHING;
    ELSE
        UPDATE public.users SET
            email          = NEW.email,
            phone          = v_phone,
            email_verified = NEW.email_confirmed_at IS NOT NULL,
            phone_verified = NEW.phone_confirmed_at IS NOT NULL,
            last_login_at  = COALESCE(NEW.last_sign_in_at, last_login_at)
        WHERE id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_auth_user_change();

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
    AFTER UPDATE OF email, phone, email_confirmed_at, phone_confirmed_at, last_sign_in_at ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_auth_user_change();

-- ---------------------------------------------------------------------
-- 4. LOCATIONS: cities & terminals
-- ---------------------------------------------------------------------
CREATE TABLE cities (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(80) NOT NULL,
    province        VARCHAR(80),
    country         VARCHAR(80) NOT NULL DEFAULT 'Pakistan',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT cities_name_uq UNIQUE (name, province)
);

CREATE TABLE terminals (
    id              SERIAL PRIMARY KEY,
    city_id         INT NOT NULL REFERENCES cities(id) ON DELETE RESTRICT,
    name            VARCHAR(120) NOT NULL,
    code            VARCHAR(10)  NOT NULL UNIQUE,      -- e.g. LHR-01
    address         TEXT,
    phone           VARCHAR(20),
    latitude        NUMERIC(9,6),
    longitude       NUMERIC(9,6),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX terminals_city_idx ON terminals (city_id);

-- ---------------------------------------------------------------------
-- 5. ROUTES
-- ---------------------------------------------------------------------
CREATE TABLE routes (
    id                    SERIAL PRIMARY KEY,
    code                  VARCHAR(20) NOT NULL UNIQUE,        -- e.g. LHR-ISB
    name                  VARCHAR(150) NOT NULL,              -- e.g. Lahore -> Islamabad
    origin_terminal_id    INT NOT NULL REFERENCES terminals(id),
    destination_terminal_id INT NOT NULL REFERENCES terminals(id),
    distance_km           NUMERIC(7,2),
    est_duration_minutes  INT CHECK (est_duration_minutes > 0),
    is_active             BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT routes_distinct_ends CHECK (origin_terminal_id <> destination_terminal_id)
);

-- Ordered stops along a route (stop_order 1 = origin, last = destination)
CREATE TABLE route_stops (
    id                    SERIAL PRIMARY KEY,
    route_id              INT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    terminal_id           INT NOT NULL REFERENCES terminals(id),
    stop_order            SMALLINT NOT NULL CHECK (stop_order > 0),
    minutes_from_origin   INT NOT NULL DEFAULT 0 CHECK (minutes_from_origin >= 0),
    km_from_origin        NUMERIC(7,2) NOT NULL DEFAULT 0,
    is_boarding_point     BOOLEAN NOT NULL DEFAULT TRUE,
    is_dropping_point     BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT route_stops_order_uq    UNIQUE (route_id, stop_order),
    CONSTRAINT route_stops_terminal_uq UNIQUE (route_id, terminal_id)
);

-- ---------------------------------------------------------------------
-- 6. FLEET: seat layouts, buses, seats, drivers
-- ---------------------------------------------------------------------
CREATE TABLE seat_layouts (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(80) NOT NULL UNIQUE,      -- e.g. "2+2 Executive 45-seater"
    total_seats     SMALLINT NOT NULL CHECK (total_seats > 0),
    row_count       SMALLINT NOT NULL CHECK (row_count > 0),
    col_count       SMALLINT NOT NULL CHECK (col_count > 0),
    decks           SMALLINT NOT NULL DEFAULT 1 CHECK (decks IN (1, 2)),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Template seats for a layout; every bus with this layout shares them
CREATE TABLE layout_seats (
    id              SERIAL PRIMARY KEY,
    layout_id       INT NOT NULL REFERENCES seat_layouts(id) ON DELETE CASCADE,
    seat_number     VARCHAR(6) NOT NULL,              -- e.g. 1A, 12, L3
    row_no          SMALLINT NOT NULL,
    col_no          SMALLINT NOT NULL,
    deck            SMALLINT NOT NULL DEFAULT 1,
    kind            seat_kind NOT NULL DEFAULT 'standard',
    is_bookable     BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT layout_seats_number_uq   UNIQUE (layout_id, seat_number),
    CONSTRAINT layout_seats_position_uq UNIQUE (layout_id, deck, row_no, col_no)
);

CREATE TABLE buses (
    id                  SERIAL PRIMARY KEY,
    registration_no     VARCHAR(20) NOT NULL UNIQUE,  -- number plate
    fleet_no            VARCHAR(20) UNIQUE,
    layout_id           INT NOT NULL REFERENCES seat_layouts(id),
    bus_class           bus_class NOT NULL DEFAULT 'executive',
    make                VARCHAR(60),                  -- e.g. Yutong, Daewoo, Hino
    model               VARCHAR(60),
    manufacture_year    SMALLINT CHECK (manufacture_year BETWEEN 1980 AND 2100),
    amenities           JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ["ac","wifi","charging","snacks","lcd"]
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE drivers (
    id                  SERIAL PRIMARY KEY,
    full_name           VARCHAR(120) NOT NULL,
    phone               VARCHAR(20) NOT NULL,
    cnic                VARCHAR(15) UNIQUE,
    license_no          VARCHAR(40) NOT NULL UNIQUE,
    license_expiry      DATE NOT NULL,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- 7. FARES (per route segment and bus class)
-- ---------------------------------------------------------------------
CREATE TABLE fares (
    id                  SERIAL PRIMARY KEY,
    route_id            INT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    from_stop_id        INT NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
    to_stop_id          INT NOT NULL REFERENCES route_stops(id) ON DELETE CASCADE,
    bus_class           bus_class NOT NULL,
    amount              NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
    currency            CHAR(3) NOT NULL DEFAULT 'PKR',
    valid_from          DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_to            DATE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fares_stops_distinct CHECK (from_stop_id <> to_stop_id),
    CONSTRAINT fares_validity CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
CREATE INDEX fares_lookup_idx ON fares (route_id, from_stop_id, to_stop_id, bus_class, valid_from);

-- ---------------------------------------------------------------------
-- 8. SCHEDULES (recurring timetable) & TRIPS (dated departures)
-- ---------------------------------------------------------------------
CREATE TABLE schedules (
    id                  SERIAL PRIMARY KEY,
    route_id            INT NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    departure_time      TIME NOT NULL,                -- local departure from origin
    bus_class           bus_class NOT NULL,
    default_bus_id      INT REFERENCES buses(id) ON DELETE SET NULL,
    days_of_week        SMALLINT[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',  -- ISO: 1=Mon ... 7=Sun
    effective_from      DATE NOT NULL DEFAULT CURRENT_DATE,
    effective_to        DATE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT schedules_days_valid CHECK (days_of_week <@ ARRAY[1,2,3,4,5,6,7]::SMALLINT[])
);
CREATE INDEX schedules_route_idx ON schedules (route_id);

CREATE TABLE trips (
    id                  BIGSERIAL PRIMARY KEY,
    schedule_id         INT REFERENCES schedules(id) ON DELETE SET NULL,
    route_id            INT NOT NULL REFERENCES routes(id),
    bus_id              INT NOT NULL REFERENCES buses(id),
    driver_id           INT REFERENCES drivers(id) ON DELETE SET NULL,
    co_driver_id        INT REFERENCES drivers(id) ON DELETE SET NULL,
    hostess_name        VARCHAR(120),
    departure_at        TIMESTAMPTZ NOT NULL,
    arrival_at          TIMESTAMPTZ NOT NULL,
    status              trip_status NOT NULL DEFAULT 'scheduled',
    delay_minutes       INT NOT NULL DEFAULT 0,
    booking_open        BOOLEAN NOT NULL DEFAULT TRUE,
    booking_closes_at   TIMESTAMPTZ,                   -- e.g. 30 min before departure
    cancel_reason       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT trips_times_valid CHECK (arrival_at > departure_at),
    CONSTRAINT trips_drivers_distinct CHECK (co_driver_id IS NULL OR co_driver_id <> driver_id)
);
-- one departure per schedule per moment
CREATE UNIQUE INDEX trips_schedule_departure_uq ON trips (schedule_id, departure_at) WHERE schedule_id IS NOT NULL;
CREATE INDEX trips_search_idx  ON trips (route_id, departure_at) WHERE status IN ('scheduled', 'delayed', 'boarding');
CREATE INDEX trips_bus_idx     ON trips (bus_id, departure_at);
CREATE INDEX trips_driver_idx  ON trips (driver_id, departure_at);

-- ---------------------------------------------------------------------
-- 9. PROMO CODES
-- ---------------------------------------------------------------------
CREATE TABLE promo_codes (
    id                  SERIAL PRIMARY KEY,
    code                VARCHAR(30) NOT NULL,
    description         TEXT,
    discount_type       discount_type NOT NULL,
    discount_value      NUMERIC(10,2) NOT NULL CHECK (discount_value > 0),
    max_discount        NUMERIC(10,2),
    min_booking_amount  NUMERIC(10,2) NOT NULL DEFAULT 0,
    usage_limit         INT,                            -- NULL = unlimited
    per_user_limit      INT NOT NULL DEFAULT 1,
    times_used          INT NOT NULL DEFAULT 0,
    valid_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to            TIMESTAMPTZ NOT NULL,
    route_id            INT REFERENCES routes(id) ON DELETE CASCADE,  -- NULL = all routes
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT promo_pct_range CHECK (discount_type <> 'percentage' OR discount_value <= 100),
    CONSTRAINT promo_validity  CHECK (valid_to > valid_from)
);
CREATE UNIQUE INDEX promo_codes_code_uq ON promo_codes (upper(code));

-- ---------------------------------------------------------------------
-- 10. BOOKINGS & TICKETS
-- ---------------------------------------------------------------------
CREATE TABLE bookings (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    pnr                 VARCHAR(10) NOT NULL UNIQUE,    -- customer-facing reference, e.g. NK7Q2X9A
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,   -- NULL for guest/walk-in
    trip_id             BIGINT NOT NULL REFERENCES trips(id),
    boarding_stop_id    INT NOT NULL REFERENCES route_stops(id),
    dropping_stop_id    INT NOT NULL REFERENCES route_stops(id),
    contact_name        VARCHAR(120) NOT NULL,
    contact_phone       VARCHAR(20)  NOT NULL,
    contact_email       VARCHAR(255),
    holder_cnic         VARCHAR(13),                    -- booking holder's CNIC, 13 digits: checked before a counter refund
    status              booking_status NOT NULL DEFAULT 'pending',
    channel             booking_channel NOT NULL DEFAULT 'web',
    booked_by_agent_id  UUID REFERENCES users(id) ON DELETE SET NULL,   -- counter staff / agent
    promo_code_id       INT REFERENCES promo_codes(id) ON DELETE SET NULL,
    subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    tax_amount          NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount        NUMERIC(10,2) GENERATED ALWAYS AS (subtotal - discount_amount + tax_amount) STORED,
    currency            CHAR(3) NOT NULL DEFAULT 'PKR',
    hold_expires_at     TIMESTAMPTZ,                    -- pending bookings expire if unpaid
    expiry_seen_at      TIMESTAMPTZ,                    -- customer was shown the "reservation expired" notice
    confirmed_at        TIMESTAMPTZ,
    cancelled_at        TIMESTAMPTZ,
    cancel_reason       TEXT,
    notes               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bookings_stops_distinct CHECK (boarding_stop_id <> dropping_stop_id),
    CONSTRAINT bookings_discount_le_subtotal CHECK (discount_amount <= subtotal),
    CONSTRAINT bookings_holder_cnic_format CHECK (holder_cnic IS NULL OR holder_cnic ~ '^[0-9]{13}$')
);
CREATE INDEX bookings_user_idx      ON bookings (user_id, created_at DESC);
CREATE INDEX bookings_trip_idx      ON bookings (trip_id);
CREATE INDEX bookings_phone_idx     ON bookings (contact_phone);
CREATE INDEX bookings_pending_idx   ON bookings (hold_expires_at) WHERE status = 'pending';

-- One row per passenger / seat
CREATE TABLE tickets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_no           VARCHAR(20) NOT NULL UNIQUE,      -- NK-YYYYMMDD-000001 = 18 chars
    booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    trip_id             BIGINT NOT NULL REFERENCES trips(id),
    seat_id             INT NOT NULL REFERENCES layout_seats(id),
    passenger_name      VARCHAR(120) NOT NULL,
    passenger_gender    gender_type NOT NULL,
    passenger_age       SMALLINT CHECK (passenger_age BETWEEN 0 AND 120),
    passenger_cnic      VARCHAR(15),
    passenger_phone     VARCHAR(20),
    fare_amount         NUMERIC(10,2) NOT NULL CHECK (fare_amount >= 0),
    status              ticket_status NOT NULL DEFAULT 'held',
    boarded_at          TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT tickets_gender_mf CHECK (passenger_gender IN ('male', 'female'))
);
-- *** Prevents double booking: a seat can have only ONE active ticket per trip ***
CREATE UNIQUE INDEX tickets_trip_seat_active_uq
    ON tickets (trip_id, seat_id)
    WHERE status IN ('held', 'reserved', 'confirmed', 'boarded');
CREATE INDEX tickets_booking_idx ON tickets (booking_id);

-- ---------------------------------------------------------------------
-- 11. PAYMENTS & REFUNDS
-- ---------------------------------------------------------------------
CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    method              payment_method NOT NULL,
    status              payment_status NOT NULL DEFAULT 'initiated',
    amount              NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    currency            CHAR(3) NOT NULL DEFAULT 'PKR',
    gateway             VARCHAR(40),                    -- e.g. jazzcash, easypaisa, stripe
    gateway_txn_id      VARCHAR(120),
    gateway_response    JSONB,
    idempotency_key     VARCHAR(80) UNIQUE,             -- guards against double charges on retry
    received_by         UUID REFERENCES users(id) ON DELETE SET NULL,  -- cashier for cash payments
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE UNIQUE INDEX payments_gateway_txn_uq ON payments (gateway, gateway_txn_id) WHERE gateway_txn_id IS NOT NULL;

CREATE TABLE refunds (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id          UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
    booking_id          UUID NOT NULL REFERENCES bookings(id) ON DELETE RESTRICT,
    ticket_id           UUID REFERENCES tickets(id) ON DELETE SET NULL,  -- NULL = whole booking
    amount              NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    cancellation_fee    NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (cancellation_fee >= 0),
    status              refund_status NOT NULL DEFAULT 'requested',
    reason              TEXT,
    gateway_refund_id   VARCHAR(120),
    processed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    processed_at        TIMESTAMPTZ,
    -- 'online': approved by a super admin, sent back through the payment provider.
    -- 'counter': paid in cash and cancelled at a counter, paid out in cash on the spot.
    channel             VARCHAR(10) NOT NULL DEFAULT 'online',
    identity_check      VARCHAR(10),                    -- how counter staff confirmed the holder
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT refunds_channel_valid CHECK (channel IN ('online', 'counter')),
    CONSTRAINT refunds_identity_check_valid CHECK (identity_check IS NULL OR identity_check IN ('cnic', 'sms_code'))
);
CREATE INDEX refunds_booking_idx ON refunds (booking_id);

-- One-time codes sent by SMS to confirm a booking's holder before a counter refund (bookings with no CNIC).
CREATE TABLE refund_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    code_hash       CHAR(64) NOT NULL,                 -- sha256 of booking id + code; the code itself is never stored
    sent_to         VARCHAR(20) NOT NULL,
    requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    attempts        SMALLINT NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refund_codes_booking_idx ON refund_codes (booking_id, created_at DESC);

-- Hours-before-departure -> refund % rules
CREATE TABLE cancellation_policies (
    id                  SERIAL PRIMARY KEY,
    name                VARCHAR(80) NOT NULL,
    min_hours_before    INT NOT NULL CHECK (min_hours_before >= 0),
    refund_percent      NUMERIC(5,2) NOT NULL CHECK (refund_percent BETWEEN 0 AND 100),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT cancellation_policies_hours_uq UNIQUE (min_hours_before)
);

-- ---------------------------------------------------------------------
-- 12. FEEDBACK, NOTIFICATIONS, AUDIT
-- ---------------------------------------------------------------------
CREATE TABLE reviews (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id          UUID NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    trip_id             BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    rating              SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment             TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID REFERENCES users(id) ON DELETE CASCADE,
    booking_id          UUID REFERENCES bookings(id) ON DELETE CASCADE,
    channel             VARCHAR(20) NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp', 'push')),
    recipient           VARCHAR(255) NOT NULL,
    template            VARCHAR(60) NOT NULL,           -- booking_confirmed, trip_delayed, ...
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    status              VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
    error               TEXT,
    sent_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_queue_idx ON notifications (created_at) WHERE status = 'queued';

-- Website content edited from the admin panel; a section with no row uses the text built into the frontend.
CREATE TABLE site_content (
    key         VARCHAR(40) PRIMARY KEY,
    value       JSONB NOT NULL,
    updated_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
    id                  BIGSERIAL PRIMARY KEY,
    actor_id            UUID REFERENCES users(id) ON DELETE SET NULL,
    action              VARCHAR(60) NOT NULL,           -- booking.cancel, trip.update, ...
    entity_type         VARCHAR(40) NOT NULL,
    entity_id           TEXT NOT NULL,
    old_data            JSONB,
    new_data            JSONB,
    ip_address          INET,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);

-- ---------------------------------------------------------------------
-- 13. updated_at TRIGGERS
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'users', 'terminals', 'routes', 'buses', 'drivers', 'schedules',
        'trips', 'bookings', 'tickets', 'payments', 'refunds'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER %I BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
            t || '_set_updated_at', t);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- 14. BUSINESS-RULE TRIGGERS
-- ---------------------------------------------------------------------

-- Ticket must use a bookable seat that belongs to the trip's bus layout,
-- and its trip_id must match its booking.
CREATE OR REPLACE FUNCTION validate_ticket_seat()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_layout_id     INT;
    v_seat          layout_seats%ROWTYPE;
    v_booking_trip  BIGINT;
BEGIN
    SELECT trip_id INTO v_booking_trip FROM bookings WHERE id = NEW.booking_id;
    IF v_booking_trip IS DISTINCT FROM NEW.trip_id THEN
        RAISE EXCEPTION 'Ticket trip_id (%) does not match booking trip_id (%)', NEW.trip_id, v_booking_trip;
    END IF;

    SELECT b.layout_id INTO v_layout_id
    FROM trips t JOIN buses b ON b.id = t.bus_id
    WHERE t.id = NEW.trip_id;

    SELECT * INTO v_seat FROM layout_seats WHERE id = NEW.seat_id;

    IF v_seat.layout_id IS DISTINCT FROM v_layout_id THEN
        RAISE EXCEPTION 'Seat % does not belong to the bus assigned to trip %', NEW.seat_id, NEW.trip_id;
    END IF;
    IF NOT v_seat.is_bookable THEN
        RAISE EXCEPTION 'Seat % is not bookable', v_seat.seat_number;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_validate_seat
    BEFORE INSERT OR UPDATE OF seat_id, trip_id, passenger_gender ON tickets
    FOR EACH ROW EXECUTE FUNCTION validate_ticket_seat();

-- Seat and gender rule: no seat is reserved for women, but a male and a female passenger from DIFFERENT
-- bookings may not sit side by side, meaning neighbouring seats in the same row on the same side of the aisle
-- (1A-1B, 1C-1D; across the aisle is fine). A mixed pair inside ONE booking (a family) is allowed.
CREATE OR REPLACE FUNCTION seat_aisle_after(p_layout_id INT)
RETURNS SMALLINT LANGUAGE sql STABLE SET search_path = public AS $$
    -- Column the aisle runs after, the same rule the website's seat map draws:
    -- 4 across (2+2) -> after column 2; 3 across (1+2) -> after column 1; 5+ across -> the middle; else no aisle.
    SELECT (CASE WHEN m = 4 THEN 2 WHEN m = 3 THEN 1 WHEN m >= 5 THEN m / 2 ELSE 0 END)::SMALLINT
    FROM (SELECT max(col_no) AS m FROM layout_seats WHERE layout_id = p_layout_id) x;
$$;

CREATE OR REPLACE FUNCTION validate_ticket_seat_neighbours()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_seat   layout_seats%ROWTYPE;
    v_aisle  SMALLINT;
    v_clash  TEXT;
BEGIN
    IF NEW.status NOT IN ('held', 'reserved', 'confirmed', 'boarded') THEN
        RETURN NEW;
    END IF;
    -- Boarding or confirming a ticket that already holds its seat changes nothing about who sits where.
    IF TG_OP = 'UPDATE' AND OLD.status IN ('held', 'reserved', 'confirmed', 'boarded')
       AND NEW.seat_id = OLD.seat_id AND NEW.trip_id = OLD.trip_id AND NEW.passenger_gender = OLD.passenger_gender THEN
        RETURN NEW;
    END IF;

    -- One booking at a time per trip, so two people cannot take a mixed pair at the same moment.
    PERFORM pg_advisory_xact_lock(7311, (NEW.trip_id % 2147483647)::INT);

    SELECT * INTO v_seat FROM layout_seats WHERE id = NEW.seat_id;
    v_aisle := seat_aisle_after(v_seat.layout_id);

    SELECT nb.seat_number INTO v_clash
    FROM layout_seats nb
    JOIN tickets tk ON tk.seat_id = nb.id
                   AND tk.trip_id = NEW.trip_id
                   AND tk.status IN ('held', 'reserved', 'confirmed', 'boarded')
                   AND tk.booking_id <> NEW.booking_id
                   AND tk.passenger_gender <> NEW.passenger_gender
    WHERE nb.layout_id = v_seat.layout_id
      AND nb.deck = v_seat.deck
      AND nb.row_no = v_seat.row_no
      AND abs(nb.col_no - v_seat.col_no) = 1
      AND least(nb.col_no, v_seat.col_no) <> v_aisle
    LIMIT 1;

    IF v_clash IS NOT NULL THEN
        RAISE EXCEPTION USING
            ERRCODE = 'NKG01',
            MESSAGE = CASE WHEN NEW.passenger_gender = 'male'
                THEN format('Seat %s is next to a female passenger (seat %s). A male passenger cannot sit beside her. Please choose another seat.', v_seat.seat_number, v_clash)
                ELSE format('Seat %s is next to a male passenger (seat %s). A female passenger cannot sit beside him. Please choose another seat.', v_seat.seat_number, v_clash)
            END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER tickets_validate_seat_neighbours
    BEFORE INSERT OR UPDATE OF seat_id, trip_id, passenger_gender, status ON tickets
    FOR EACH ROW EXECUTE FUNCTION validate_ticket_seat_neighbours();

-- Boarding stop must come before dropping stop, both on the trip's route
CREATE OR REPLACE FUNCTION validate_booking_stops()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_route_id  INT;
    b_stop      route_stops%ROWTYPE;
    d_stop      route_stops%ROWTYPE;
BEGIN
    SELECT route_id INTO v_route_id FROM trips WHERE id = NEW.trip_id;
    SELECT * INTO b_stop FROM route_stops WHERE id = NEW.boarding_stop_id;
    SELECT * INTO d_stop FROM route_stops WHERE id = NEW.dropping_stop_id;

    IF b_stop.route_id <> v_route_id OR d_stop.route_id <> v_route_id THEN
        RAISE EXCEPTION 'Boarding/dropping stops are not on the route of trip %', NEW.trip_id;
    END IF;
    IF b_stop.stop_order >= d_stop.stop_order THEN
        RAISE EXCEPTION 'Boarding stop must come before dropping stop';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_validate_stops
    BEFORE INSERT OR UPDATE OF trip_id, boarding_stop_id, dropping_stop_id ON bookings
    FOR EACH ROW EXECUTE FUNCTION validate_booking_stops();

-- When a booking is cancelled/expired, release its seats automatically
CREATE OR REPLACE FUNCTION release_seats_on_booking_end()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.status IN ('cancelled', 'expired', 'refunded') AND OLD.status IS DISTINCT FROM NEW.status THEN
        UPDATE tickets SET status = 'cancelled'
        WHERE booking_id = NEW.id AND status IN ('held', 'reserved', 'confirmed');
        IF NEW.status = 'cancelled' AND NEW.cancelled_at IS NULL THEN
            NEW.cancelled_at := now();
        END IF;
    ELSIF NEW.status = 'confirmed' AND OLD.status IS DISTINCT FROM 'confirmed' THEN
        UPDATE tickets SET status = 'confirmed'
        WHERE booking_id = NEW.id AND status IN ('held', 'reserved');
        NEW.confirmed_at := COALESCE(NEW.confirmed_at, now());
        NEW.hold_expires_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER bookings_status_change
    BEFORE UPDATE OF status ON bookings
    FOR EACH ROW EXECUTE FUNCTION release_seats_on_booking_end();

-- ---------------------------------------------------------------------
-- 15. FUNCTIONS FOR THE APP
-- ---------------------------------------------------------------------

-- Expire unpaid pending bookings (call from a cron job / before seat lookup).
-- A booking whose customer opened a Safepay checkout keeps its seats up to 20 minutes past the hold, so the
-- backend's expiry job can ask Safepay whether it was paid before the seats are released.
-- Returns the number of bookings expired.
CREATE OR REPLACE FUNCTION expire_stale_bookings()
RETURNS INT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n INT;
BEGIN
    UPDATE bookings b SET status = 'expired'
    WHERE b.status = 'pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at < now()
      AND (b.hold_expires_at < now() - interval '20 minutes'
           OR NOT EXISTS (SELECT 1 FROM payments p
                          WHERE p.booking_id = b.id AND p.gateway = 'safepay'
                            AND p.status IN ('initiated', 'pending') AND p.gateway_txn_id IS NOT NULL));
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;

-- Generate a unique 8-char PNR, e.g. NK4F7Q2M (no ambiguous chars 0/O/1/I)
CREATE OR REPLACE FUNCTION generate_pnr()
RETURNS VARCHAR LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    chars  TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    result TEXT;
BEGIN
    LOOP
        result := 'NK';
        FOR i IN 1..6 LOOP
            result := result || substr(chars, 1 + floor(random() * length(chars))::INT, 1);
        END LOOP;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings WHERE pnr = result);
    END LOOP;
    RETURN result;
END;
$$;
ALTER TABLE bookings ALTER COLUMN pnr SET DEFAULT generate_pnr();

-- Ticket numbers: NK-<yyyymmdd>-<sequence>
CREATE SEQUENCE ticket_no_seq;
ALTER TABLE tickets ALTER COLUMN ticket_no
    SET DEFAULT 'NK-' || to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYYMMDD') || '-' || lpad(nextval('ticket_no_seq')::TEXT, 6, '0');

-- ---------------------------------------------------------------------
-- 16. VIEWS
-- ---------------------------------------------------------------------

-- Seat map for a trip: SELECT * FROM v_trip_seat_map WHERE trip_id = 123;
CREATE VIEW v_trip_seat_map AS
SELECT
    t.id                AS trip_id,
    ls.id               AS seat_id,
    ls.seat_number,
    ls.row_no,
    ls.col_no,
    ls.deck,
    ls.kind,
    CASE
        WHEN NOT ls.is_bookable THEN 'unavailable'
        WHEN tk.id IS NULL      THEN 'available'
        ELSE tk.status::TEXT
    END                 AS seat_status,
    tk.passenger_gender AS occupant_gender   -- seat map colours and the side-by-side rule
FROM trips t
JOIN buses b         ON b.id = t.bus_id
JOIN layout_seats ls ON ls.layout_id = b.layout_id
LEFT JOIN tickets tk ON tk.trip_id = t.id
                    AND tk.seat_id = ls.id
                    AND tk.status IN ('held', 'reserved', 'confirmed', 'boarded');

-- Trip search results with availability
CREATE VIEW v_trip_search AS
SELECT
    t.id                    AS trip_id,
    r.code                  AS route_code,
    r.name                  AS route_name,
    oc.name                 AS origin_city,
    dc.name                 AS destination_city,
    t.departure_at,
    t.arrival_at,
    t.status,
    b.bus_class,
    b.amenities,
    sl.total_seats,
    (SELECT count(*) FROM layout_seats x WHERE x.layout_id = b.layout_id AND x.is_bookable)
        - occ.booked        AS seats_available
FROM trips t
JOIN routes r        ON r.id = t.route_id
JOIN terminals ot    ON ot.id = r.origin_terminal_id
JOIN cities oc       ON oc.id = ot.city_id
JOIN terminals dt    ON dt.id = r.destination_terminal_id
JOIN cities dc       ON dc.id = dt.city_id
JOIN buses b         ON b.id = t.bus_id
JOIN seat_layouts sl ON sl.id = b.layout_id
LEFT JOIN LATERAL (
    SELECT count(*) AS booked FROM tickets tk
    WHERE tk.trip_id = t.id AND tk.status IN ('held', 'reserved', 'confirmed', 'boarded')
) occ ON TRUE
WHERE t.booking_open
  AND t.status IN ('scheduled', 'delayed');

-- Daily revenue summary
CREATE VIEW v_daily_revenue AS
SELECT
    (p.paid_at AT TIME ZONE 'Asia/Karachi')::DATE AS day,
    p.method,
    count(*)        AS payments,
    sum(p.amount)   AS gross_amount
FROM payments p
WHERE p.status IN ('succeeded', 'partially_refunded')
GROUP BY 1, 2;

-- ---------------------------------------------------------------------
-- 17. LOCK DOWN THE SUPABASE DATA API
--     RLS on, no policies => anon/authenticated see nothing.
--     The backend's postgres role bypasses RLS.
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, public;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.handle_auth_user_change() TO supabase_auth_admin;

-- ---------------------------------------------------------------------
-- 18. SEED / REFERENCE DATA (safe defaults — edit as needed)
-- ---------------------------------------------------------------------
INSERT INTO cancellation_policies (name, min_hours_before, refund_percent) VALUES
    ('48h+ before departure',  48, 90),
    ('24-48h before departure', 24, 75),
    ('6-24h before departure',  6, 50),
    ('Less than 6h',            0,  0);

INSERT INTO cities (name, province) VALUES
    ('Lahore',     'Punjab'),
    ('Islamabad',  'Islamabad Capital Territory'),
    ('Rawalpindi', 'Punjab'),
    ('Faisalabad', 'Punjab'),
    ('Multan',     'Punjab'),
    ('Peshawar',   'Khyber Pakhtunkhwa'),
    ('Karachi',    'Sindh');

COMMIT;

-- =====================================================================
-- TYPICAL BOOKING FLOW (reference, not executed)
-- ---------------------------------------------------------------------
--  BEGIN;
--    SELECT expire_stale_bookings();
--    INSERT INTO bookings (user_id, trip_id, boarding_stop_id, dropping_stop_id,
--                              contact_name, contact_phone, subtotal, hold_expires_at)
--    VALUES (..., now() + interval '10 minutes') RETURNING id, pnr;
--    INSERT INTO tickets (booking_id, trip_id, seat_id, passenger_name,
--                             passenger_gender, fare_amount) VALUES (...);
--    -- unique violation on tickets_trip_seat_active_uq => seat already taken
--  COMMIT;
--  -- after payment succeeds:
--  UPDATE bookings SET status = 'confirmed' WHERE id = ...;   -- tickets auto-confirm
-- =====================================================================
