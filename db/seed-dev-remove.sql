-- Removes the test data added by seed-dev.sql (and any bookings made on its trips).
-- Run: npm run seed:dev:remove   (or paste into Supabase -> SQL editor)
BEGIN;
DELETE FROM refunds  WHERE booking_id IN (SELECT b.id FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id WHERE r.code LIKE 'NK-%');
DELETE FROM payments WHERE booking_id IN (SELECT b.id FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id WHERE r.code LIKE 'NK-%');
DELETE FROM tickets  WHERE trip_id IN (SELECT t.id FROM trips t JOIN routes r ON r.id = t.route_id WHERE r.code LIKE 'NK-%');
DELETE FROM bookings WHERE trip_id IN (SELECT t.id FROM trips t JOIN routes r ON r.id = t.route_id WHERE r.code LIKE 'NK-%');
DELETE FROM trips    WHERE route_id IN (SELECT id FROM routes WHERE code LIKE 'NK-%');
DELETE FROM routes   WHERE code LIKE 'NK-%';          -- cascades to route_stops, fares, schedules
DELETE FROM buses    WHERE registration_no LIKE 'DEV-%';
DELETE FROM seat_layouts WHERE name = 'NK 2+2 AC 40-seater';   -- cascades to layout_seats
DELETE FROM terminals WHERE code LIKE 'NK-%';
COMMIT;
