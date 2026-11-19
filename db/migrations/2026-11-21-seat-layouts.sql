-- 2026-11-21: New Khan fleet seat layouts (NK 2+2 49-seater, NK 2+1 31-seater), numbered 1, 2, 3 ...
--
-- 1. seat_layouts.is_active: layouts offered when adding a bus. The test layout "NK 2+2 AC 40-seater" is switched
--    off (no fleet bus uses 40 seats). It is not deleted: the test buses and their tickets still use it.
-- 2. create_coach_layout(name, driver_side, door_side, rows, back_row): builds a coach layout.
--      Seen from inside facing the front, the driver sits on the RIGHT (Pakistan). Columns run left (door side)
--      to right (driver side) with the aisle as an EMPTY column between the two sides. Row 0 holds the driver seat
--      ('D', not bookable). Seats are numbered 1, 2, 3 ... from the driver side across each row, row by row to the
--      back. The back row (if any) is one complete bench across the full width, including the aisle position.
--        NK 2+2 49-seater: create_coach_layout('NK 2+2 49-seater', 2, 2, 11, 5)   rows "4 3 . 2 1", back "49 48 47 46 45"
--        NK 2+1 31-seater: create_coach_layout('NK 2+1 31-seater', 2, 1, 9, 4)    rows "3 . 2 1",   back "31 30 29 28"
--      A future 45-seater: create_coach_layout('NK 2+2 45-seater', 2, 2, 10, 5).
--      Does nothing if a layout with that name already exists (returns its id).
-- 3. Side-by-side gender rule: in a layout whose aisle is an empty column, two seats are side by side when they
--    are in the same row in neighbouring columns. So across the aisle never counts (the columns are two apart), and
--    every seat in the full-width back row counts as beside the seats next to it. Layouts without an empty column
--    (the old 40-seater) keep the old rule exactly.
--
-- Safe to run more than once. Existing buses, trips and tickets are not changed.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-21-seat-layouts.sql)
BEGIN;

-- 1. Layouts offered for new buses
ALTER TABLE seat_layouts ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
UPDATE seat_layouts SET is_active = FALSE WHERE name = 'NK 2+2 AC 40-seater';

-- 2. The layout generator
CREATE OR REPLACE FUNCTION create_coach_layout(p_name TEXT, p_driver_side INT, p_door_side INT, p_rows INT, p_back_row INT)
RETURNS INT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    v_id    INT;
    v_cols  INT := p_door_side + 1 + p_driver_side;   -- door side, aisle, driver side
    v_aisle INT := p_door_side + 1;                   -- the empty aisle column
    v_n     INT := 0;
    r       INT;
    c       INT;
    kind_of TEXT;
BEGIN
    IF p_driver_side < 1 OR p_door_side < 1 OR p_rows < 1 THEN
        RAISE EXCEPTION 'create_coach_layout: need at least one seat on each side and one row';
    END IF;
    IF p_back_row NOT IN (0, v_cols) THEN
        RAISE EXCEPTION 'create_coach_layout: the back row is a full-width bench of % seats (or 0 for none)', v_cols;
    END IF;

    SELECT id INTO v_id FROM seat_layouts WHERE name = p_name;
    IF v_id IS NOT NULL THEN
        RETURN v_id;
    END IF;

    INSERT INTO seat_layouts (name, total_seats, row_count, col_count, decks)
    VALUES (p_name, p_rows * (p_driver_side + p_door_side) + p_back_row,
            p_rows + CASE WHEN p_back_row > 0 THEN 1 ELSE 0 END, v_cols, 1)
    RETURNING id INTO v_id;

    -- The driver, front row, driver side. Not a passenger seat.
    INSERT INTO layout_seats (layout_id, seat_number, row_no, col_no, deck, kind, is_bookable)
    VALUES (v_id, 'D', 0, v_cols, 1, 'driver', FALSE);

    FOR r IN 1 .. p_rows LOOP
        -- Driver side first (right to left), then across the aisle (right to left).
        FOR c IN REVERSE v_cols .. v_aisle + 1 LOOP
            v_n := v_n + 1;
            kind_of := CASE WHEN c = v_cols THEN 'window' WHEN c = v_aisle + 1 THEN 'aisle' ELSE 'standard' END;
            INSERT INTO layout_seats (layout_id, seat_number, row_no, col_no, deck, kind, is_bookable)
            VALUES (v_id, v_n::TEXT, r, c, 1, kind_of::seat_kind, TRUE);
        END LOOP;
        FOR c IN REVERSE v_aisle - 1 .. 1 LOOP
            v_n := v_n + 1;
            kind_of := CASE WHEN c = 1 THEN 'window' WHEN c = v_aisle - 1 THEN 'aisle' ELSE 'standard' END;
            INSERT INTO layout_seats (layout_id, seat_number, row_no, col_no, deck, kind, is_bookable)
            VALUES (v_id, v_n::TEXT, r, c, 1, kind_of::seat_kind, TRUE);
        END LOOP;
    END LOOP;

    -- The back row: one bench across the full width, driver side to door side.
    IF p_back_row > 0 THEN
        FOR c IN REVERSE v_cols .. 1 LOOP
            v_n := v_n + 1;
            kind_of := CASE WHEN c IN (1, v_cols) THEN 'window' ELSE 'standard' END;
            INSERT INTO layout_seats (layout_id, seat_number, row_no, col_no, deck, kind, is_bookable)
            VALUES (v_id, v_n::TEXT, p_rows + 1, c, 1, kind_of::seat_kind, TRUE);
        END LOOP;
    END IF;

    RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION create_coach_layout(TEXT, INT, INT, INT, INT) FROM anon, authenticated, public;

SELECT create_coach_layout('NK 2+2 49-seater', 2, 2, 11, 5);
SELECT create_coach_layout('NK 2+1 31-seater', 2, 1, 9, 4);

-- 3. Where the aisle is, for the side-by-side gender rule (validate_ticket_seat_neighbours uses this).
--    0 = no aisle to skip: the aisle is an empty column (a row has a gap), so only seats in neighbouring
--    columns are side by side, which also makes the full-width back row one bench.
--    Otherwise (no row has a gap, like the old 40-seater) the old rule, unchanged.
CREATE OR REPLACE FUNCTION seat_aisle_after(p_layout_id INT)
RETURNS SMALLINT LANGUAGE sql STABLE SET search_path = public AS $$
    SELECT (CASE
        WHEN EXISTS (SELECT 1 FROM layout_seats g WHERE g.layout_id = p_layout_id
                     GROUP BY g.deck, g.row_no HAVING count(*) < max(g.col_no) - min(g.col_no) + 1) THEN 0
        WHEN m = 4 THEN 2 WHEN m = 3 THEN 1 WHEN m >= 5 THEN m / 2 ELSE 0 END)::SMALLINT
    FROM (SELECT max(col_no) AS m FROM layout_seats WHERE layout_id = p_layout_id) x;
$$;
REVOKE ALL ON FUNCTION seat_aisle_after(INT) FROM anon, authenticated, public;

COMMIT;
