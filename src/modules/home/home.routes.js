/**
 * Home screens for each role.
 *   GET /counter/departures?date&terminalId   counter officer: the day's buses at their terminal, with seats left,
 *                                              destinations and fares for a quick sale, voucher and arrival state
 *   GET /me/trips                              driver / conductor: their own trips (2 days back, 7 ahead)
 *   GET /board?date                            manager: every trip of the day, missing crew, vouchers, reports waiting
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, EMPLOYEE_ROLES, MANAGER_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { intId, isoDate } from '../../utils/schemas.js';

const TZ = 'Asia/Karachi';
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const ACTIVE = `('held', 'reserved', 'confirmed', 'boarded')`;

export const homeRouter = Router();

// ---------------------------------------------------------------------------------------------------------------
// Counter officer
// ---------------------------------------------------------------------------------------------------------------
homeRouter.get(
  '/counter/departures',
  requireAuth,
  requireRole(...STAFF_ROLES),
  validate({ query: z.object({ date: isoDate.optional(), terminalId: intId.optional() }).strict() }),
  async (req, res) => {
    const date = req.valid.query.date ?? today();
    // Counter staff: always their own terminal. Managers and admins: the one they pick (or their own).
    const terminalId = req.user.role === 'agent' ? req.user.terminalId : req.valid.query.terminalId ?? req.user.terminalId;
    if (!terminalId) throw AppError.badRequest(req.user.role === 'agent' ? 'Your account has no terminal. Ask an admin to set one.' : 'Choose a terminal.');
    const terminal = await one(`SELECT t.id, t.name, c.name AS city FROM terminals t JOIN cities c ON c.id = t.city_id WHERE t.id = $1`, [terminalId]);
    if (!terminal) throw AppError.notFound('Terminal not found');

    const { rows } = await query(
      `SELECT t.id AS trip_id, t.status::text AS status, t.delay_minutes, t.route_id, r.name AS route_name,
              b.registration_no AS bus_no, b.fleet_no, b.bus_class::text AS bus_class,
              rs.id AS stop_id, rs.stop_order, rs.is_boarding_point,
              r.destination_terminal_id = $1 AS ends_here,
              t.departure_at + make_interval(mins => rs.minutes_from_origin + t.delay_minutes) AS here_at,
              (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = b.layout_id AND ls.is_bookable)::int AS seats,
              (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status IN ${ACTIVE})::int AS taken,
              v.id AS voucher_id, v.voucher_no,
              lv.terminal_name AS last_left, lv.generated_at AS last_left_at,
              d.full_name AS driver_name, cn.full_name AS conductor_name,
              (t.conductor_id IS NOT NULL OR t.stand_in_conductor_id IS NOT NULL) AS has_conductor,
              t.booking_open
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN route_stops rs ON rs.route_id = r.id AND rs.terminal_id = $1
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN conductors cn ON cn.id = t.conductor_id
       LEFT JOIN trip_vouchers v ON v.trip_id = t.id AND v.boarding_stop_id = rs.id AND v.status = 'generated'
       LEFT JOIN LATERAL (
          SELECT tv.terminal_name, tv.generated_at FROM trip_vouchers tv
          WHERE tv.trip_id = t.id AND tv.status = 'generated' ORDER BY tv.generated_at DESC LIMIT 1
       ) lv ON TRUE
       WHERE t.status <> 'cancelled'
         AND ((t.departure_at + make_interval(mins => rs.minutes_from_origin + t.delay_minutes)) AT TIME ZONE '${TZ}')::date = $2::date
       ORDER BY here_at`,
      [terminalId, date],
    );

    // Destinations and fares from this terminal, for each trip that boards here.
    const routeIds = [...new Set(rows.map((r) => r.routeId))];
    const [stops, fares] = await Promise.all([
      query(
        `SELECT rs.id, rs.route_id, rs.stop_order, rs.is_dropping_point, c.name AS city FROM route_stops rs
         JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
         WHERE rs.route_id = ANY ($1::int[]) ORDER BY rs.route_id, rs.stop_order`,
        [routeIds],
      ),
      query(
        `SELECT DISTINCT ON (route_id, from_stop_id, to_stop_id, bus_class) route_id, from_stop_id, to_stop_id, bus_class::text AS bus_class, amount
         FROM fares WHERE route_id = ANY ($1::int[]) AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to >= $2::date)
         ORDER BY route_id, from_stop_id, to_stop_id, bus_class, valid_from DESC`,
        [routeIds, date],
      ),
    ]);

    const departures = rows.map((r) => {
      const later = stops.rows.filter((s) => s.routeId === r.routeId && s.stopOrder > r.stopOrder && s.isDroppingPoint);
      const destinations = later
        .map((s) => ({
          stopId: s.id,
          city: s.city,
          fare: fares.rows.find((f) => f.routeId === r.routeId && f.fromStopId === r.stopId && f.toStopId === s.id && f.busClass === r.busClass)?.amount ?? null,
        }))
        .filter((x) => x.fare !== null);
      const boards = r.isBoardingPoint && destinations.length > 0;
      return {
        tripId: r.tripId,
        status: r.status,
        delayMinutes: r.delayMinutes,
        routeName: r.routeName,
        busNo: r.busNo,
        fleetNo: r.fleetNo,
        stopId: r.stopId,
        hereAt: r.hereAt,
        endsHere: r.endsHere,
        boardsHere: boards,
        seatsLeft: Math.max(0, r.seats - r.taken),
        seats: r.seats,
        voucher: r.voucherId ? { id: r.voucherId, voucherNo: r.voucherNo } : null,
        // Counter sales close when this terminal's voucher is generated.
        canSell: boards && !r.voucherId && r.bookingOpen && ['scheduled', 'delayed', 'boarding', 'departed'].includes(r.status),
        lastLeft: r.lastLeft,
        lastLeftAt: r.lastLeftAt,
        driverName: r.driverName,
        conductorName: r.conductorName,
        hasConductor: r.hasConductor,
        destinations,
      };
    });
    res.set('Cache-Control', 'no-store');
    res.json({ data: { date, terminal: { id: terminal.id, name: terminal.name, city: terminal.city }, departures } });
  },
);

// ---------------------------------------------------------------------------------------------------------------
// Driver / conductor: my trips
// ---------------------------------------------------------------------------------------------------------------
homeRouter.get('/me/trips', requireAuth, requireRole(...EMPLOYEE_ROLES), async (req, res) => {
  const { rows } = await query(
    `SELECT t.id, t.departure_at, t.arrival_at, t.delay_minutes, t.status::text AS status, t.route_id, r.name AS route_name,
            b.registration_no AS bus_no, b.fleet_no, t.hostess_name,
            d.full_name AS driver_name, d.phone AS driver_phone, cn.full_name AS conductor_name, cn.phone AS conductor_phone,
            CASE WHEN de.user_id = $1 THEN 'driver' ELSE 'conductor' END AS my_role
     FROM trips t
     JOIN routes r ON r.id = t.route_id
     JOIN buses b ON b.id = t.bus_id
     LEFT JOIN drivers d ON d.id = t.driver_id
     LEFT JOIN employees de ON de.id = d.employee_id
     LEFT JOIN conductors cn ON cn.id = t.conductor_id
     WHERE (de.user_id = $1 OR cn.user_id = $1 OR t.stand_in_conductor_id = $1)
       AND t.departure_at BETWEEN now() - interval '2 days' AND now() + interval '8 days'
       AND t.status <> 'cancelled'
     ORDER BY t.departure_at`,
    [req.user.id],
  );
  const routeIds = [...new Set(rows.map((t) => t.routeId))];
  const { rows: stops } = await query(
    `SELECT rs.route_id, rs.minutes_from_origin, c.name AS city FROM route_stops rs
     JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
     WHERE rs.route_id = ANY ($1::int[]) ORDER BY rs.route_id, rs.stop_order`,
    [routeIds],
  );
  const trips = rows.map((t) => {
    const start = new Date(t.departureAt).getTime() + (t.delayMinutes ?? 0) * 60_000;
    return {
      ...t,
      stops: stops.filter((s) => s.routeId === t.routeId).map((s) => ({ city: s.city, at: new Date(start + s.minutesFromOrigin * 60_000).toISOString() })),
    };
  });
  res.set('Cache-Control', 'no-store');
  res.json({ data: trips });
});

// ---------------------------------------------------------------------------------------------------------------
// Manager board
// ---------------------------------------------------------------------------------------------------------------
homeRouter.get(
  '/board',
  requireAuth,
  requireRole(...MANAGER_ROLES),
  validate({ query: z.object({ date: isoDate.optional() }).strict() }),
  async (req, res) => {
    const date = req.valid.query.date ?? today();
    const { rows: trips } = await query(
      `SELECT t.id, t.departure_at, t.delay_minutes, t.status::text AS status, r.name AS route_name,
              oc.name AS from_city, b.registration_no AS bus_no,
              d.full_name AS driver_name, d.license_expiry < CURRENT_DATE AS driver_licence_expired,
              COALESCE(cn.full_name, si.full_name) AS conductor_name,
              (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status IN ${ACTIVE})::int AS seats_taken,
              (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = b.layout_id AND ls.is_bookable)::int AS seats,
              (SELECT count(*) FROM route_stops rs WHERE rs.route_id = r.id AND rs.is_boarding_point
                 AND rs.stop_order < (SELECT max(stop_order) FROM route_stops x WHERE x.route_id = r.id))::int AS voucher_stops,
              (SELECT count(*) FROM trip_vouchers tv WHERE tv.trip_id = t.id AND tv.status = 'generated')::int AS vouchers,
              lv.terminal_name AS last_left, lv.generated_at AS last_left_at,
              (SELECT l.round_trip_id FROM round_trip_legs l WHERE l.trip_id = t.id) AS round_trip_id
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
       JOIN buses b ON b.id = t.bus_id
       LEFT JOIN drivers d ON d.id = t.driver_id
       LEFT JOIN conductors cn ON cn.id = t.conductor_id
       LEFT JOIN users si ON si.id = t.stand_in_conductor_id
       LEFT JOIN LATERAL (
          SELECT tv.terminal_name, tv.generated_at FROM trip_vouchers tv
          WHERE tv.trip_id = t.id AND tv.status = 'generated' ORDER BY tv.generated_at DESC LIMIT 1
       ) lv ON TRUE
       WHERE (t.departure_at AT TIME ZONE '${TZ}')::date = $1::date
       ORDER BY t.departure_at`,
      [date],
    );
    const live = trips.filter((t) => t.status !== 'cancelled');
    const [plan, drafts] = await Promise.all([
      one(`SELECT version, published_at, published_by_name FROM day_plans WHERE plan_date = $1`, [date]),
      one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE auto_created)::int AS auto FROM round_trips WHERE status = 'draft'`),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({
      data: {
        date,
        counts: {
          trips: live.length,
          scheduled: live.filter((t) => t.status === 'scheduled').length,
          boarding: live.filter((t) => t.status === 'boarding').length,
          departed: live.filter((t) => t.status === 'departed').length,
          arrived: live.filter((t) => t.status === 'arrived').length,
          delayed: live.filter((t) => t.status === 'delayed' || t.delayMinutes > 0).length,
          cancelled: trips.length - live.length,
          missingCrew: live.filter((t) => !t.driverName || !t.conductorName).length,
          seatsSold: live.reduce((s, t) => s + t.seatsTaken, 0),
        },
        trips,
        dayPlan: plan,
        draftReports: drafts,
      },
    });
  },
);
