-- =====================================================================
-- DEV / TEST DATA for New Khan. Safe to run more than once.
-- Run: npm run seed:dev   (or paste into Supabase -> SQL editor)
--
-- Adds New Khan towns and terminals, 2+2 AC seat layout (40 seats), 16 Higer coaches, 8 routes
-- (each direction of Lahore-DI Khan via Sargodha and Mianwali, Lahore-Multan, Lahore-Bhakkar,
-- Lahore-Islamabad), fares for every stop pair, 2 daily schedules per route and trips for the
-- next 30 days. Fares and times are placeholders. Remove with db/seed-dev-remove.sql.
-- Everything it creates is tagged: terminal/route codes start with "NK", buses with "DEV-".
-- =====================================================================
BEGIN;

-- ---- Towns (existing cities are reused by name) ----
INSERT INTO cities (name, province)
SELECT v.name, v.province
FROM (VALUES ('Lahore', 'Punjab'), ('Sargodha', 'Punjab'), ('Mianwali', 'Punjab'), ('Bhakkar', 'Punjab'),
             ('DI Khan', 'Khyber Pakhtunkhwa'), ('Multan', 'Punjab'), ('Islamabad', 'Islamabad Capital Territory')) AS v(name, province)
WHERE NOT EXISTS (SELECT 1 FROM cities c WHERE c.name = v.name);

-- ---- Terminals ----
INSERT INTO terminals (city_id, name, code, address, phone)
SELECT c.id, v.tname, v.code, v.address, '0311 1007555'
FROM (VALUES
  ('Lahore',    'New Khan Lahore Terminal',    'NK-LHR', '55 Lawrence Road, Lahore'),
  ('Sargodha',  'New Khan Sargodha Terminal',  'NK-SGD', 'Address to be confirmed'),
  ('Mianwali',  'New Khan Mianwali Terminal',  'NK-MWL', 'Address to be confirmed'),
  ('Bhakkar',   'New Khan Bhakkar Terminal',   'NK-BHK', 'Address to be confirmed'),
  ('DI Khan',   'New Khan DI Khan Terminal',   'NK-DIK', 'Address to be confirmed'),
  ('Multan',    'New Khan Multan Terminal',    'NK-MUL', 'Address to be confirmed'),
  ('Islamabad', 'New Khan Islamabad Terminal', 'NK-ISB', 'Address to be confirmed')
) AS v(city, tname, code, address)
JOIN cities c ON c.name = v.city
ON CONFLICT (code) DO NOTHING;

-- ---- Seat layout: 2+2 AC coach, 10 rows x 4 (A B | C D) ----
INSERT INTO seat_layouts (name, total_seats, row_count, col_count)
VALUES ('NK 2+2 AC 40-seater', 40, 10, 4)
ON CONFLICT (name) DO NOTHING;

INSERT INTO layout_seats (layout_id, seat_number, row_no, col_no, kind)
SELECT l.id, r || chr(64 + c), r, c,
       (CASE WHEN c IN (1, 4) THEN 'window' ELSE 'aisle' END)::seat_kind
FROM seat_layouts l, generate_series(1, 10) r, generate_series(1, 4) c
WHERE l.name = 'NK 2+2 AC 40-seater'
ON CONFLICT (layout_id, seat_number) DO NOTHING;

-- ---- Coaches ----
INSERT INTO buses (registration_no, fleet_no, layout_id, bus_class, make, model, manufacture_year, amenities)
SELECT 'DEV-' || lpad(n::text, 3, '0'), 'NK-' || lpad(n::text, 2, '0'), l.id, 'executive', 'Higer', 'KLQ6128', 2025,
       '["ac", "charging", "reclining"]'::jsonb
FROM seat_layouts l, generate_series(1, 16) n
WHERE l.name = 'NK 2+2 AC 40-seater'
ON CONFLICT (registration_no) DO NOTHING;

-- ---- Routes and their stops: (route code, name, [terminal code, minutes from origin, km from origin]...) ----
CREATE TEMP TABLE seed_stops (route_code text, route_name text, stop_order int, terminal_code text, mins int, km numeric) ON COMMIT DROP;
INSERT INTO seed_stops VALUES
  ('NK-LHR-DIK', 'Lahore → DI Khan (via Sargodha, Mianwali)', 1, 'NK-LHR',   0,   0),
  ('NK-LHR-DIK', 'Lahore → DI Khan (via Sargodha, Mianwali)', 2, 'NK-SGD', 210, 190),
  ('NK-LHR-DIK', 'Lahore → DI Khan (via Sargodha, Mianwali)', 3, 'NK-MWL', 300, 290),
  ('NK-LHR-DIK', 'Lahore → DI Khan (via Sargodha, Mianwali)', 4, 'NK-DIK', 480, 450),
  ('NK-DIK-LHR', 'DI Khan → Lahore (via Mianwali, Sargodha)', 1, 'NK-DIK',   0,   0),
  ('NK-DIK-LHR', 'DI Khan → Lahore (via Mianwali, Sargodha)', 2, 'NK-MWL', 180, 160),
  ('NK-DIK-LHR', 'DI Khan → Lahore (via Mianwali, Sargodha)', 3, 'NK-SGD', 270, 260),
  ('NK-DIK-LHR', 'DI Khan → Lahore (via Mianwali, Sargodha)', 4, 'NK-LHR', 480, 450),
  ('NK-LHR-MUL', 'Lahore → Multan',    1, 'NK-LHR', 0, 0),   ('NK-LHR-MUL', 'Lahore → Multan',    2, 'NK-MUL', 300, 340),
  ('NK-MUL-LHR', 'Multan → Lahore',    1, 'NK-MUL', 0, 0),   ('NK-MUL-LHR', 'Multan → Lahore',    2, 'NK-LHR', 300, 340),
  ('NK-LHR-BHK', 'Lahore → Bhakkar',   1, 'NK-LHR', 0, 0),   ('NK-LHR-BHK', 'Lahore → Bhakkar',   2, 'NK-BHK', 360, 330),
  ('NK-BHK-LHR', 'Bhakkar → Lahore',   1, 'NK-BHK', 0, 0),   ('NK-BHK-LHR', 'Bhakkar → Lahore',   2, 'NK-LHR', 360, 330),
  ('NK-LHR-ISB', 'Lahore → Islamabad', 1, 'NK-LHR', 0, 0),   ('NK-LHR-ISB', 'Lahore → Islamabad', 2, 'NK-ISB', 270, 380),
  ('NK-ISB-LHR', 'Islamabad → Lahore', 1, 'NK-ISB', 0, 0),   ('NK-ISB-LHR', 'Islamabad → Lahore', 2, 'NK-LHR', 270, 380);

INSERT INTO routes (code, name, origin_terminal_id, destination_terminal_id, distance_km, est_duration_minutes)
SELECT f.route_code, f.route_name, ot.id, dt.id, l.km, l.mins
FROM seed_stops f
JOIN seed_stops l ON l.route_code = f.route_code AND l.stop_order = (SELECT max(stop_order) FROM seed_stops x WHERE x.route_code = f.route_code)
JOIN terminals ot ON ot.code = f.terminal_code
JOIN terminals dt ON dt.code = l.terminal_code
WHERE f.stop_order = 1
ON CONFLICT (code) DO NOTHING;

INSERT INTO route_stops (route_id, terminal_id, stop_order, minutes_from_origin, km_from_origin)
SELECT r.id, t.id, s.stop_order, s.mins, s.km
FROM seed_stops s JOIN routes r ON r.code = s.route_code JOIN terminals t ON t.code = s.terminal_code
ON CONFLICT (route_id, stop_order) DO NOTHING;

-- ---- Fares for every stop pair: about Rs 5 per km, rounded to Rs 50, at least Rs 400 (placeholder) ----
INSERT INTO fares (route_id, from_stop_id, to_stop_id, bus_class, amount, valid_from)
SELECT r.id, a.id, b.id, 'executive', GREATEST(400, round((b.km_from_origin - a.km_from_origin) * 5.2 / 50) * 50), CURRENT_DATE - 1
FROM routes r
JOIN route_stops a ON a.route_id = r.id
JOIN route_stops b ON b.route_id = r.id AND b.stop_order > a.stop_order
WHERE r.code LIKE 'NK-%'
  AND NOT EXISTS (SELECT 1 FROM fares f WHERE f.from_stop_id = a.id AND f.to_stop_id = b.id AND f.bus_class = 'executive');

-- ---- Two daily departures per route, each with its own coach so buses never clash ----
CREATE TEMP TABLE seed_sched (route_code text, dep time, bus_reg text) ON COMMIT DROP;
INSERT INTO seed_sched VALUES
  ('NK-LHR-DIK', '07:00', 'DEV-001'), ('NK-LHR-DIK', '21:00', 'DEV-002'),
  ('NK-DIK-LHR', '07:00', 'DEV-003'), ('NK-DIK-LHR', '21:00', 'DEV-004'),
  ('NK-LHR-MUL', '09:00', 'DEV-005'), ('NK-LHR-MUL', '18:00', 'DEV-006'),
  ('NK-MUL-LHR', '09:00', 'DEV-007'), ('NK-MUL-LHR', '18:00', 'DEV-008'),
  ('NK-LHR-BHK', '08:00', 'DEV-009'), ('NK-LHR-BHK', '22:00', 'DEV-010'),
  ('NK-BHK-LHR', '08:00', 'DEV-011'), ('NK-BHK-LHR', '22:00', 'DEV-012'),
  ('NK-LHR-ISB', '10:00', 'DEV-013'), ('NK-LHR-ISB', '19:00', 'DEV-014'),
  ('NK-ISB-LHR', '10:00', 'DEV-015'), ('NK-ISB-LHR', '19:00', 'DEV-016');

INSERT INTO schedules (route_id, departure_time, bus_class, default_bus_id, effective_from)
SELECT r.id, s.dep, 'executive', b.id, CURRENT_DATE
FROM seed_sched s JOIN routes r ON r.code = s.route_code JOIN buses b ON b.registration_no = s.bus_reg
WHERE NOT EXISTS (SELECT 1 FROM schedules x WHERE x.route_id = r.id AND x.departure_time = s.dep);

-- ---- Trips for today and the next 30 days (Pakistan time), booking closes 30 minutes before departure ----
INSERT INTO trips (schedule_id, route_id, bus_id, departure_at, arrival_at, booking_closes_at)
SELECT s.id, s.route_id, s.default_bus_id, dep, dep + make_interval(mins => r.est_duration_minutes), dep - interval '30 minutes'
FROM schedules s
JOIN routes r ON r.id = s.route_id AND r.code LIKE 'NK-%'
CROSS JOIN generate_series(0, 30) d
CROSS JOIN LATERAL (SELECT ((CURRENT_DATE + d)::timestamp + s.departure_time) AT TIME ZONE 'Asia/Karachi' AS dep) x
WHERE dep > now()
ON CONFLICT (schedule_id, departure_at) WHERE schedule_id IS NOT NULL DO NOTHING;

COMMIT;
