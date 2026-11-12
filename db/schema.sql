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
CREATE TYPE user_role        AS ENUM ('customer', 'agent', 'driver', 'conductor', 'manager', 'admin', 'super_admin');
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
CREATE TYPE booking_channel  AS ENUM ('web', 'mobile_app', 'counter', 'phone', 'agent', 'on_road');

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
    CONSTRAINT refunds_identity_check_valid CHECK (identity_check IS NULL OR identity_check IN ('cnic', 'sms_code', 'manager'))
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

-- SMS (off until SMS_API_URL is set): every message tried, phone-verification codes, verified numbers
CREATE TABLE sms_messages (
    id          BIGSERIAL PRIMARY KEY,
    to_masked   VARCHAR(20),
    kind        VARCHAR(30) NOT NULL,          -- booking_confirmed | phone_code | refund_code
    booking_id  UUID REFERENCES bookings(id) ON DELETE SET NULL,
    status      VARCHAR(10) NOT NULL CHECK (status IN ('sent', 'failed')),
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sms_messages_created_idx ON sms_messages (created_at DESC);
CREATE UNIQUE INDEX sms_messages_one_confirmation ON sms_messages (booking_id) WHERE kind = 'booking_confirmed' AND status = 'sent';

CREATE TABLE phone_codes (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone       VARCHAR(20) NOT NULL,
    code_hash   CHAR(64) NOT NULL,
    attempts    INT NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX phone_codes_user_idx ON phone_codes (user_id, created_at DESC);

CREATE TABLE verified_phones (
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone        VARCHAR(20) NOT NULL,
    verified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, phone)
);

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
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC, id DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);

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

-- ---------------------------------------------------------------------
-- 19. ROUND TRIP REPORTS (same as db/migrations/2026-11-07-round-trip-reports.sql)
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 20. ROLES, CONDUCTORS, TERMINAL VOUCHERS (same as db/migrations/2026-11-10-terminal-vouchers-conductors.sql)
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 21. ROUND TRIP REPORTS FROM TRIPS AND VOUCHERS (same as db/migrations/2026-11-11-round-trip-from-vouchers.sql)
-- ---------------------------------------------------------------------
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

-- ---------------------------------------------------------------------
-- 22. ORIGIN TERMINALS, AUTOMATIC ROUND TRIP REPORTS (same as db/migrations/2026-11-12-origin-terminals-auto-reports.sql)
-- ---------------------------------------------------------------------
ALTER TABLE terminals ADD COLUMN IF NOT EXISTS is_origin BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE terminals t SET is_origin = TRUE
FROM cities c
WHERE c.id = t.city_id AND lower(c.name) IN ('lahore', 'multan') AND NOT t.is_origin;

ALTER TABLE round_trips ADD COLUMN IF NOT EXISTS auto_created BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------------------------------------------------------------------
-- 23. EMPLOYEES (same as db/migrations/2026-11-13-employees.sql)
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------------------------------------------------
-- 1. Lists
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_name_uq ON departments (lower(name));

-- crew: where the system uses people of this designation (Bus & crew, round trip reports).
-- suggested_role: the login role offered when an account is linked (the admin decides).
CREATE TABLE IF NOT EXISTS designations (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(60) NOT NULL,
    crew            VARCHAR(12),
    suggested_role  VARCHAR(20),
    sort_order      SMALLINT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT designations_crew_valid CHECK (crew IS NULL OR crew IN ('driver', 'conductor', 'hostess', 'cashier'))
);
CREATE UNIQUE INDEX IF NOT EXISTS designations_name_uq ON designations (lower(name));

CREATE TABLE IF NOT EXISTS licence_types (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS licence_types_name_uq ON licence_types (lower(name));

CREATE TABLE IF NOT EXISTS licence_authorities (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS licence_authorities_name_uq ON licence_authorities (lower(name));

INSERT INTO departments (name, sort_order) VALUES ('Operational Staff', 1) ON CONFLICT DO NOTHING;

INSERT INTO designations (name, crew, suggested_role, sort_order) VALUES
    ('GM', NULL, 'manager', 1),
    ('AGM', NULL, 'manager', 2),
    ('Stand Manager (SM)', NULL, 'manager', 3),
    ('ASM', NULL, 'manager', 4),
    ('Booking Officer', NULL, 'agent', 5),
    ('Loader', NULL, NULL, 6),
    ('Driver', 'driver', 'driver', 7),
    ('Conductor / Fare Collector', 'conductor', 'conductor', 8),
    ('Hostess', 'hostess', NULL, 9),
    ('Cashier', 'cashier', 'agent', 10)
ON CONFLICT DO NOTHING;

INSERT INTO licence_types (name, sort_order) VALUES
    ('HPSV (Heavy Passenger Service Vehicle)', 1), ('HTV (Heavy Transport Vehicle)', 2),
    ('LPSV (Light Passenger Service Vehicle)', 3), ('LTV (Light Transport Vehicle)', 4),
    ('Motor Car / Jeep', 5), ('Other', 6)
ON CONFLICT DO NOTHING;

INSERT INTO licence_authorities (name, sort_order) VALUES
    ('Punjab (DLIMS / Traffic Police)', 1), ('Islamabad (ITP)', 2), ('Sindh', 3), ('Khyber Pakhtunkhwa', 4),
    ('Balochistan', 5), ('Gilgit-Baltistan', 6), ('Azad Jammu & Kashmir', 7), ('Motorway Police (NHMP)', 8), ('Other', 9)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Employees
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_counter (
    id       SMALLINT PRIMARY KEY CHECK (id = 1),
    last_no  INT NOT NULL CHECK (last_no < 99999)
);
INSERT INTO employee_counter (id, last_no) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

/** Next employee ID. The counter row stays locked until the saving transaction ends: unique, and a cancelled save
    gives its number back, so opening and closing the form never uses one up. */
CREATE OR REPLACE FUNCTION next_employee_code()
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = public AS $$
    UPDATE employee_counter SET last_no = last_no + 1 WHERE id = 1 RETURNING 'NK-' || lpad(last_no::TEXT, 5, '0');
$$;

CREATE TABLE IF NOT EXISTS employees (
    id                  SERIAL PRIMARY KEY,
    employee_code       VARCHAR(10) NOT NULL,
    full_name           VARCHAR(120) NOT NULL,
    department_id       INT REFERENCES departments(id) ON DELETE SET NULL,
    designation_id      INT REFERENCES designations(id) ON DELETE SET NULL,
    joining_date        DATE,
    cnic                VARCHAR(15),
    cnic_expiry         DATE,
    marital_status      VARCHAR(10),
    current_address     VARCHAR(300),
    permanent_address   VARCHAR(300),
    city                VARCHAR(80),
    phone               VARCHAR(20),
    blood_group         VARCHAR(3),
    licence_no          VARCHAR(40),
    licence_type_id     INT REFERENCES licence_types(id) ON DELETE SET NULL,
    licence_expiry      DATE,
    licence_authority   VARCHAR(80),
    notes               VARCHAR(1000),
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,      -- their login, if they have one
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    left_on             DATE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT employees_code_uq UNIQUE (employee_code),
    CONSTRAINT employees_code_format CHECK (employee_code ~ '^NK-[0-9]{5}$'),
    CONSTRAINT employees_marital_valid CHECK (marital_status IS NULL OR marital_status IN ('single', 'married', 'widowed', 'divorced')),
    CONSTRAINT employees_blood_valid CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'))
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_cnic_uq ON employees (cnic) WHERE cnic IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employees_user_uq ON employees (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_name_idx ON employees (lower(full_name));
CREATE INDEX IF NOT EXISTS employees_designation_idx ON employees (designation_id, is_active);

CREATE OR REPLACE FUNCTION set_employee_code()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.employee_code := next_employee_code();   -- always system-generated
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS employees_set_code ON employees;
CREATE TRIGGER employees_set_code BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION set_employee_code();

CREATE OR REPLACE FUNCTION keep_employee_code()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
        RAISE EXCEPTION 'An employee ID cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS employees_keep_code ON employees;
CREATE TRIGGER employees_keep_code BEFORE UPDATE OF employee_code ON employees FOR EACH ROW EXECUTE FUNCTION keep_employee_code();

DROP TRIGGER IF EXISTS employees_set_updated_at ON employees;
CREATE TRIGGER employees_set_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Drivers and conductors used by trips, linked to their employee.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS employee_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE conductors ADD COLUMN IF NOT EXISTS employee_id INT REFERENCES employees(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS drivers_employee_uq ON drivers (employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conductors_employee_uq ON conductors (employee_id) WHERE employee_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Existing drivers, conductors and staff directory become employees (each once).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
    r        RECORD;
    v_id     INT;
    v_dept   INT := (SELECT id FROM departments WHERE lower(name) = 'operational staff');
    v_cnic   TEXT;
    v_note   TEXT;
BEGIN
    FOR r IN SELECT * FROM drivers WHERE employee_id IS NULL ORDER BY id LOOP
        v_cnic := r.cnic; v_note := 'Moved from the Drivers list.';
        IF v_cnic IS NOT NULL AND EXISTS (SELECT 1 FROM employees WHERE cnic = v_cnic) THEN
            v_note := v_note || ' CNIC ' || v_cnic || ' is already on another employee: please check.'; v_cnic := NULL;
        END IF;
        INSERT INTO employees (employee_code, full_name, department_id, designation_id, cnic, phone, licence_no, licence_expiry,
                               licence_type_id, is_active, notes)
        VALUES ('NK-00000', r.full_name, v_dept, (SELECT id FROM designations WHERE name = 'Driver'), v_cnic, r.phone, r.license_no,
                r.license_expiry, (SELECT id FROM licence_types WHERE name LIKE 'HPSV%'), r.is_active, v_note)
        RETURNING id INTO v_id;
        UPDATE drivers SET employee_id = v_id WHERE id = r.id;
    END LOOP;

    FOR r IN SELECT * FROM conductors WHERE employee_id IS NULL ORDER BY id LOOP
        v_cnic := r.cnic; v_note := 'Moved from the Conductors list.';
        IF v_cnic IS NOT NULL AND EXISTS (SELECT 1 FROM employees WHERE cnic = v_cnic) THEN
            v_note := v_note || ' CNIC ' || v_cnic || ' is already on another employee: please check.'; v_cnic := NULL;
        END IF;
        INSERT INTO employees (employee_code, full_name, department_id, designation_id, cnic, phone, user_id, is_active, notes)
        VALUES ('NK-00000', r.full_name, v_dept, (SELECT id FROM designations WHERE name = 'Conductor / Fare Collector'), v_cnic, r.phone,
                CASE WHEN r.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees WHERE user_id = r.user_id) THEN r.user_id END,
                r.is_active, v_note)
        RETURNING id INTO v_id;
        UPDATE conductors SET employee_id = v_id WHERE id = r.id;
    END LOOP;

    -- Staff directory (cleaners, loaders...): loaders keep their designation, others are noted for HR to set.
    FOR r IN SELECT * FROM staff_directory s
             WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.notes LIKE '%[staff directory #' || s.id || ']%') ORDER BY id LOOP
        v_cnic := r.cnic;
        IF v_cnic IS NOT NULL AND EXISTS (SELECT 1 FROM employees WHERE cnic = v_cnic) THEN v_cnic := NULL; END IF;
        INSERT INTO employees (employee_code, full_name, department_id, designation_id, cnic, phone, is_active, notes)
        VALUES ('NK-00000', r.full_name, v_dept, CASE WHEN r.job = 'loader' THEN (SELECT id FROM designations WHERE name = 'Loader') END,
                v_cnic, r.phone, r.is_active,
                'Moved from the Staff directory (job: ' || r.job || ') [staff directory #' || r.id || '].' || COALESCE(' ' || r.notes, ''));
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Security: only the backend reads and writes these tables.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['departments','designations','licence_types','licence_authorities','employee_counter','employees'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION next_employee_code() FROM anon, authenticated, public;

-- ---------------------------------------------------------------------
-- 24. DAY PLANS (same as db/migrations/2026-11-14-day-plans.sql)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS day_plans (
    plan_date          DATE PRIMARY KEY,
    version            INT NOT NULL DEFAULT 1 CHECK (version > 0),
    published_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    published_by_name  VARCHAR(120) NOT NULL,
    snapshot           JSONB NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE day_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON day_plans FROM anon, authenticated;

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
