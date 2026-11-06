-- Seat and gender rule (replaces the fixed ladies-only seats):
--   * No seat is reserved for women any more: layout_seats.female_only is removed.
--   * A male and a female passenger from DIFFERENT bookings may not sit side by side. "Side by side" means
--     neighbouring seats in the same row on the same side of the aisle (1A-1B, 1C-1D); across the aisle is fine.
--     A mixed pair inside ONE booking (husband and wife, brother and sister) is allowed. Applies both ways.
--   * Passengers are male or female only.
-- Same definitions as in db/schema.sql. Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-06-seat-gender-neighbours.sql
BEGIN;

-- 1. Seat map view without female_only (the view must be rebuilt before the column can go).
DROP VIEW IF EXISTS v_trip_seat_map;
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
REVOKE ALL ON v_trip_seat_map FROM anon, authenticated;

-- 2. Seat check without the ladies-only rule.
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

ALTER TABLE layout_seats DROP COLUMN IF EXISTS female_only;

-- 3. The side-by-side rule.
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

DROP TRIGGER IF EXISTS tickets_validate_seat_neighbours ON tickets;
CREATE TRIGGER tickets_validate_seat_neighbours
    BEFORE INSERT OR UPDATE OF seat_id, trip_id, passenger_gender, status ON tickets
    FOR EACH ROW EXECUTE FUNCTION validate_ticket_seat_neighbours();

REVOKE ALL ON FUNCTION seat_aisle_after(INT) FROM anon, authenticated, public;
REVOKE ALL ON FUNCTION validate_ticket_seat_neighbours() FROM anon, authenticated, public;

-- 4. Male or female only.
UPDATE users SET gender = NULL WHERE gender = 'other';
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gender_mf;
ALTER TABLE users ADD CONSTRAINT users_gender_mf CHECK (gender IS NULL OR gender IN ('male', 'female'));

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_gender_mf;
ALTER TABLE tickets ADD CONSTRAINT tickets_gender_mf CHECK (passenger_gender IN ('male', 'female')) NOT VALID;
DO $$
BEGIN
    ALTER TABLE tickets VALIDATE CONSTRAINT tickets_gender_mf;
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'Some older tickets have gender "other". They are kept as they are; every new ticket must be male or female.';
END;
$$;

COMMIT;
