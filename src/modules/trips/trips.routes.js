import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, requireAuth, requireRole, isStaff, ADMIN_ROLES, MANAGER_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { autoCreateReport } from '../roundtrips/roundtrips.sync.js';
import { assertBusFree, createExtraDeparture, createTripWithReturn } from './trips.create.js';
import { busConfirmReady, confirmedSql, CONFIRM_FIRST } from './busConfirm.js';
import { customRouteSchema, findOrCreateRoute } from '../routes/customRoute.js';
import { terminalsMissingVoucher } from '../tripvouchers/tripVouchers.service.js';
import { cargoListsReady, voidListsForCancelledTrip } from '../cargo/cargo.lists.js';
import { expireStaleSoon } from '../../jobs/expireBookings.js';
import { searchLimiter } from '../../middleware/rateLimit.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { bigIdParam, busClass, intId, isoDate, isoDateTime, longText, personName } from '../../utils/schemas.js';
import { seatOrder } from '../../utils/seats.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];
const staff = [requireAuth, requireRole(...STAFF_ROLES)];

const ACTIVE_TICKET = `('held','reserved','confirmed','boarded')`;

// ---------------- Public: search ----------------
const searchSchema = z
  .object({
    fromCityId: intId,
    toCityId: intId,
    date: isoDate,
    busClass: busClass.optional(),
    passengers: z.coerce.number().int().min(1).max(20).default(1),
  })
  .strict()
  .refine((q) => q.fromCityId !== q.toCityId, 'Origin and destination must differ');

/**
 * Finds trips that pass through a terminal in fromCity and later a terminal in toCity,
 * departing from the boarding stop on the given date (Pakistan time).
 *
 * Every terminal is bookable on its own, so a bus that has left Lahore can still be booked from Sargodha:
 *  - online: until ONLINE_CUTOFF_MINUTES (1 hour) before the bus is due at that terminal, delays included;
 *  - counter staff (signed in): until that terminal's voucher is generated.
 * Seats taken anywhere on the trip (online, counter, road passengers) are taken for every terminal.
 */
router.get('/search', searchLimiter, optionalAuth, validate({ query: searchSchema }), async (req, res) => {
  const q = req.valid.query;
  const staffView = isStaff(req.user);
  await expireStaleSoon(); // free seats whose unpaid hold has run out (serverless hosts have no minute job)
  const { rows } = await query(
    `SELECT t.id AS trip_id, r.code AS route_code, r.name AS route_name, b.bus_class, b.amenities,
            bs.id AS boarding_stop_id, bt.name AS boarding_terminal,
            ds.id AS dropping_stop_id, dt.name AS dropping_terminal,
            t.departure_at + make_interval(mins => bs.minutes_from_origin + t.delay_minutes) AS boarding_at,
            t.departure_at + make_interval(mins => ds.minutes_from_origin + t.delay_minutes) AS dropping_at,
            t.status, t.delay_minutes, f.amount AS fare, f.currency,
            seats.bookable - seats.taken AS seats_available,
            lv.terminal_name AS last_left, lv.generated_at AS last_left_at
     FROM trips t
     JOIN routes r       ON r.id = t.route_id AND r.is_active
     JOIN buses b        ON b.id = t.bus_id
     JOIN route_stops bs ON bs.route_id = r.id AND bs.is_boarding_point
     JOIN terminals bt   ON bt.id = bs.terminal_id AND bt.city_id = $1
     JOIN route_stops ds ON ds.route_id = r.id AND ds.is_dropping_point AND ds.stop_order > bs.stop_order
     JOIN terminals dt   ON dt.id = ds.terminal_id AND dt.city_id = $2
     LEFT JOIN LATERAL (
        SELECT amount, currency FROM fares
        WHERE route_id = r.id AND from_stop_id = bs.id AND to_stop_id = ds.id AND bus_class = b.bus_class
          AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $3::date)
        ORDER BY valid_from DESC LIMIT 1
     ) f ON TRUE
     CROSS JOIN LATERAL (
        SELECT (SELECT count(*) FROM layout_seats ls WHERE ls.layout_id = b.layout_id AND ls.is_bookable)::int AS bookable,
               (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status IN ${ACTIVE_TICKET})::int AS taken
     ) seats
     -- Where the bus is: the last terminal that generated its voucher ("on route").
     LEFT JOIN LATERAL (
        SELECT tv.terminal_name, tv.generated_at FROM trip_vouchers tv
        WHERE tv.trip_id = t.id AND tv.status = 'generated' ORDER BY tv.generated_at DESC LIMIT 1
     ) lv ON TRUE
     WHERE t.status IN ('scheduled', 'delayed', 'boarding', 'departed')
       AND t.booking_open
       -- Online: closes ONLINE_CUTOFF_MINUTES before the bus is due at this terminal. Counter staff: until the
       -- voucher (checked below); 12 hours after the due time it drops off as a forgotten departure.
       AND t.departure_at + make_interval(mins => bs.minutes_from_origin + t.delay_minutes)
           > CASE WHEN $6 THEN now() - interval '12 hours' ELSE now() + make_interval(mins => $7) END
       AND t.departure_at >= ($3::date::timestamp AT TIME ZONE 'Asia/Karachi') - interval '1 day'
       AND t.departure_at <  ($3::date::timestamp AT TIME ZONE 'Asia/Karachi') + interval '1 day'
       AND ((t.departure_at + make_interval(mins => bs.minutes_from_origin)) AT TIME ZONE 'Asia/Karachi')::date = $3::date
       AND ($4::bus_class IS NULL OR b.bus_class = $4)
       AND f.amount IS NOT NULL
       AND seats.bookable - seats.taken >= $5
       -- Booking from a terminal closes when its voucher is generated.
       AND NOT EXISTS (SELECT 1 FROM trip_vouchers tv
                       WHERE tv.trip_id = t.id AND tv.boarding_stop_id = bs.id AND tv.status IN ('generated', 'replaced'))
     ORDER BY boarding_at`,
    [q.fromCityId, q.toCityId, q.date, q.busClass ?? null, q.passengers, staffView, env.ONLINE_CUTOFF_MINUTES],
  );
  res.json({ data: rows });
});

// ---------------- Staff: extra departures and bus choice ----------------

/**
 * For "Add extra departure": the routes (counter staff: only those leaving from their terminal; managers: all, or
 * those leaving from ?terminalId), the seat types (layout + class) of the active fleet, and the active buses.
 */
router.get(
  '/extra-options',
  ...staff,
  validate({ query: z.object({ terminalId: intId.optional() }).strict() }),
  async (req, res) => {
    const counter = !MANAGER_ROLES.includes(req.user.role);
    if (counter && !req.user.terminalId) throw AppError.badRequest('Your account has no terminal. Ask an admin to set one.');
    const from = counter ? req.user.terminalId : req.valid.query.terminalId ?? null;
    const [routes, busTypes, buses] = await Promise.all([
      query(
        `SELECT r.id, r.code, r.name, r.est_duration_minutes, r.origin_terminal_id, oc.name AS from_city
         FROM routes r JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
         WHERE r.is_active AND r.est_duration_minutes > 0 AND ($1::int IS NULL OR r.origin_terminal_id = $1)
         ORDER BY r.name`,
        [from],
      ),
      query(
        `SELECT b.layout_id, l.name AS layout_name, l.total_seats, b.bus_class::text AS bus_class, count(*)::int AS buses
         FROM buses b JOIN seat_layouts l ON l.id = b.layout_id
         WHERE b.is_active GROUP BY b.layout_id, l.name, l.total_seats, b.bus_class ORDER BY l.total_seats DESC, b.bus_class`,
      ),
      query(
        `SELECT b.id, b.registration_no, b.fleet_no, b.layout_id, b.bus_class::text AS bus_class, l.name AS layout_name
         FROM buses b JOIN seat_layouts l ON l.id = b.layout_id WHERE b.is_active ORDER BY b.fleet_no NULLS LAST, b.id`,
      ),
    ]);
    res.set('Cache-Control', 'no-store');
    res.json({ data: { routes: routes.rows, busTypes: busTypes.rows, buses: buses.rows, plannedAllowed: await busConfirmReady() } });
  },
);

/**
 * Buses that can go on this trip (Bus & crew): active, the same seat layout as the trip's bus, each with the
 * confirmed trip it is busy on at that time (busyTripId), if any.
 */
router.get('/:id/bus-options', ...staff, validate({ params: bigIdParam }), async (req, res) => {
  const t = await one(
    `SELECT t.id, t.departure_at, t.arrival_at, b.layout_id FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = $1`,
    [req.valid.params.id],
  );
  if (!t) throw AppError.notFound('Trip not found');
  const confirmed = await confirmedSql('o');
  const { rows } = await query(
    `SELECT b.id, b.registration_no, b.fleet_no, b.bus_class::text AS bus_class,
            (SELECT o.id FROM trips o
             WHERE o.bus_id = b.id AND o.id <> $1 AND o.status NOT IN ('cancelled', 'arrived') AND ${confirmed}
               AND tstzrange(o.departure_at, o.arrival_at) && tstzrange($3::timestamptz, $4::timestamptz)
             ORDER BY o.departure_at LIMIT 1) AS busy_trip_id
     FROM buses b WHERE b.is_active AND b.layout_id = $2
     ORDER BY b.fleet_no NULLS LAST, b.id`,
    [t.id, t.layoutId, t.departureAt, t.arrivalAt],
  );
  res.set('Cache-Control', 'no-store');
  res.json({ data: rows });
});

const extraSchema = z
  .object({
    routeId: intId,
    departureAt: isoDateTime,
    layoutId: intId.optional(),
    busClass: busClass.optional(),
    busId: intId.optional(),
    allowNear: z.boolean().optional(),
  })
  .strict();

/** An extra departure for one day (busy days), on sale at once. See createExtraDeparture. */
router.post('/extra', ...staff, validate({ body: extraSchema }), async (req, res) => {
  const { trip, planned } = await withTransaction((client) => createExtraDeparture(client, req.valid.body, req.user));
  await audit({ req, action: 'trip.create_extra', entityType: 'trip', entityId: trip.id, newData: { ...trip, plannedBus: planned } });
  res.status(201).json({ data: trip, planned });
});

// ---------------- Public: trip detail & seat map ----------------
router.get('/:id', validate({ params: bigIdParam }), async (req, res) => {
  const trip = await one(
    `SELECT t.id, t.route_id, r.name AS route_name, t.departure_at, t.arrival_at, t.status, t.delay_minutes,
            t.booking_open, t.booking_closes_at, b.bus_class, b.amenities, b.layout_id
     FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
     WHERE t.id = $1`,
    [req.valid.params.id],
  );
  if (!trip) throw AppError.notFound('Trip not found');
  const { rows: stops } = await query(
    `SELECT rs.id, rs.stop_order, t.name AS terminal_name, c.name AS city_name, rs.is_boarding_point, rs.is_dropping_point,
            $2::timestamptz + make_interval(mins => rs.minutes_from_origin) AS scheduled_at
     FROM route_stops rs JOIN terminals t ON t.id = rs.terminal_id JOIN cities c ON c.id = t.city_id
     WHERE rs.route_id = $1 ORDER BY rs.stop_order`,
    [trip.routeId, trip.departureAt],
  );
  res.json({ data: { ...trip, stops } });
});

/** Seat map. Passenger identity is never exposed, only gender (seat colours and the side-by-side rule). */
router.get('/:id/seats', searchLimiter, validate({ params: bigIdParam }), async (req, res) => {
  const exists = await one(`SELECT id FROM trips WHERE id = $1`, [req.valid.params.id]);
  if (!exists) throw AppError.notFound('Trip not found');
  await expireStaleSoon();
  const { rows } = await query(
    `SELECT seat_id, seat_number, row_no, col_no, deck, kind,
            CASE WHEN seat_status IN ('held','reserved','confirmed','boarded') THEN 'booked' ELSE seat_status END AS status,
            occupant_gender
     FROM v_trip_seat_map WHERE trip_id = $1 ORDER BY deck, row_no, col_no`,
    [req.valid.params.id],
  );
  res.json({ data: rows });
});

// ---------------- Staff / admin ----------------
const tripCreateSchema = z
  .object({
    // A saved route, or one built from chosen locations (customRoute.js): exactly one of the two.
    routeId: intId.optional(),
    customRoute: customRouteSchema.optional(),
    busId: intId,
    driverId: intId.optional(),
    coDriverId: intId.optional(),
    conductorId: intId.optional(),
    hostessName: personName.optional(),
    departureAt: isoDateTime,
    // Kept for older clients; online booking now closes ONLINE_CUTOFF_MINUTES before the bus reaches each terminal.
    bookingCloseMinutes: z.number().int().min(0).max(720).default(60),
    // Optional: the same bus comes back (one-off form, "Also add the return trip").
    returnTrip: z.object({ routeId: intId, departureAt: isoDateTime, driverId: intId.optional() }).strict().optional(),
  })
  .strict()
  .refine((t) => !t.coDriverId || t.coDriverId !== t.driverId, 'Driver and co-driver must differ')
  .refine((t) => Boolean(t.routeId) !== Boolean(t.customRoute), { path: ['routeId'], message: 'Choose a saved route, or choose the locations' });

async function assertDriversValid(client, ids) {
  for (const id of ids.filter(Boolean)) {
    const d = await one(`SELECT is_active, license_expiry >= CURRENT_DATE AS valid FROM drivers WHERE id = $1`, [id], client);
    if (!d) throw AppError.badRequest(`Driver ${id} not found`);
    if (!d.isActive || !d.valid) throw AppError.unprocessable(`Driver ${id} is inactive or has an expired license`);
  }
}

async function assertConductorValid(client, id) {
  if (!id) return;
  const c = await one(`SELECT is_active FROM conductors WHERE id = $1`, [id], client);
  if (!c) throw AppError.badRequest('Conductor not found');
  if (!c.isActive) throw AppError.unprocessable('That conductor is inactive');
}

async function assertStandInValid(client, userId) {
  if (!userId) return;
  const u = await one(`SELECT role::text, is_active FROM users WHERE id = $1`, [userId], client);
  if (!u || !u.isActive || u.role === 'customer') throw AppError.badRequest('The stand-in conductor must be an active staff member');
}

router.post('/', ...admin, validate({ body: tripCreateSchema }), async (req, res) => {
  const b = req.valid.body;
  if (Date.parse(b.departureAt) <= Date.now()) throw AppError.badRequest('Departure must be in the future');

  // With `returnTrip`, the same bus's return trip is created too: both or neither (see trips.create.js).
  // A route built from chosen locations is found or created with the trip: both or neither.
  const { trip, returnTrip, warnings, route } = await withTransaction(async (client) => {
    const { customRoute, ...rest } = b;
    const built = customRoute ? await findOrCreateRoute(client, customRoute) : null;
    const made = await createTripWithReturn(client, built ? { ...rest, routeId: built.id } : rest);
    return { ...made, route: built };
  });
  if (route?.created) {
    await audit({ req, action: 'route.create', entityType: 'route', entityId: route.id, newData: { code: route.code, name: route.name, ...b.customRoute, builtFor: 'trip' } });
  }
  await audit({ req, action: 'trip.create', entityType: 'trip', entityId: trip.id, newData: trip });
  if (returnTrip) {
    await audit({ req, action: 'trip.create', entityType: 'trip', entityId: returnTrip.id, newData: { ...returnTrip, returnOfTripId: trip.id } });
  }
  // `route` (only when locations were chosen): { id, code, name, created, hasFares }.
  res.status(201).json({ data: trip, returnTrip, warnings, route });
});

router.get(
  '/',
  ...staff,
  validate({
    query: z
      .object({
        date: isoDate,
        routeId: intId.optional(),
        status: z.enum(['scheduled', 'boarding', 'departed', 'arrived', 'cancelled', 'delayed']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    // Counter staff see only the buses that pick up passengers at their terminal (a boarding point, not the last
    // stop: the voucher terminals), on the day the bus is there, with the time it is there (delay included).
    // Buses ending at their terminal are on the Counter screen ("Arriving here").
    const counter = !MANAGER_ROLES.includes(req.user.role);
    if (counter && !req.user.terminalId) throw AppError.badRequest('Your account has no terminal. Ask an admin to set one.');
    const mine = counter ? req.user.terminalId : null;
    const confirmed = await confirmedSql('t');
    const { rows } = await query(
      `SELECT t.*, ${confirmed} AS bus_confirmed, r.name AS route_name, r.origin_terminal_id,
              my.here_at, my.here_city, -- counter staff: when the bus is at their terminal (delay included)
              -- counter staff: their own terminal's voucher is generated (the bus has left them)
              EXISTS (SELECT 1 FROM trip_vouchers mv WHERE mv.trip_id = t.id AND mv.boarding_stop_id = my.stop_id AND mv.status = 'generated') AS my_voucher_done,
              b.registration_no, b.fleet_no, b.layout_id, b.bus_class, d.full_name AS driver_name,
              cn.full_name AS conductor_name, si.full_name AS stand_in_conductor_name,
              (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status IN ${ACTIVE_TICKET})::int AS seats_taken,
              (SELECT count(*) FROM trip_vouchers tv WHERE tv.trip_id = t.id AND tv.status = 'generated')::int AS vouchers_generated,
              lv.terminal_name AS last_left, lv.generated_at AS last_left_at,
              r.destination_terminal_id, dt.is_origin AS ends_at_origin,
              (SELECT l.round_trip_id FROM round_trip_legs l WHERE l.trip_id = t.id) AS round_trip_id
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
       LEFT JOIN drivers d ON d.id = t.driver_id
       JOIN terminals dt ON dt.id = r.destination_terminal_id
       LEFT JOIN conductors cn ON cn.id = t.conductor_id
       LEFT JOIN users si ON si.id = t.stand_in_conductor_id
       LEFT JOIN LATERAL (
          SELECT tv.terminal_name, tv.generated_at FROM trip_vouchers tv
          WHERE tv.trip_id = t.id AND tv.status = 'generated' ORDER BY tv.generated_at DESC LIMIT 1
       ) lv ON TRUE
       LEFT JOIN LATERAL (
          SELECT rs.id AS stop_id, c.name AS here_city,
                 t.departure_at + make_interval(mins => rs.minutes_from_origin + t.delay_minutes) AS here_at,
                 t.departure_at + make_interval(mins => rs.minutes_from_origin) AS here_scheduled
          FROM route_stops rs JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
          WHERE rs.route_id = t.route_id AND rs.terminal_id = $4 AND rs.is_boarding_point
            AND rs.stop_order < (SELECT max(x.stop_order) FROM route_stops x WHERE x.route_id = t.route_id)
       ) my ON TRUE
       WHERE ($4::int IS NULL OR my.stop_id IS NOT NULL)
         -- The day by the timetable (a delay past midnight does not move a bus to the next day's list).
         AND ((CASE WHEN $4::int IS NULL THEN t.departure_at ELSE my.here_scheduled END) AT TIME ZONE 'Asia/Karachi')::date = $1::date
         AND ($2::int IS NULL OR t.route_id = $2)
         AND ($3::trip_status IS NULL OR t.status = $3)
       ORDER BY COALESCE(my.here_at, t.departure_at), t.departure_at`,
      [q.date, q.routeId ?? null, q.status ?? null, mine],
    );
    res.json({ data: rows });
  },
);

/**
 * Assign bus / crew. Saving with a bus CONFIRMS it (busConfirm.js): the planned bus or another one. A different bus
 * must have the same seat layout (passengers keep their seat numbers) and must not be on another confirmed trip.
 * Counter staff: only departures leaving from their own terminal, before the bus leaves, and not the stand-in.
 */
router.patch(
  '/:id/assignment',
  ...staff,
  validate({
    params: bigIdParam,
    body: z
      .object({
        busId: intId,
        driverId: intId.nullable(),
        coDriverId: intId.nullable(),
        conductorId: intId.nullable(),
        // A staff member sent as conductor when the conductor could not go. Can be set after the trip too.
        standInConductorId: z.string().uuid().nullable(),
        hostessName: personName.nullable(),
      })
      .partial()
      .strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    const counter = !MANAGER_ROLES.includes(req.user.role);
    const warnings = [];
    const trip = await withTransaction(async (client) => {
      const confirmed = await confirmedSql('t', client);
      const t = await one(
        `SELECT t.*, ${confirmed} AS bus_confirmed, bu.layout_id, bu.bus_class, bu.registration_no, r.origin_terminal_id
         FROM trips t JOIN buses bu ON bu.id = t.bus_id JOIN routes r ON r.id = t.route_id
         WHERE t.id = $1 FOR UPDATE OF t`,
        [id],
        client,
      );
      if (!t) throw AppError.notFound('Trip not found');
      if (counter) {
        if (!req.user.terminalId || req.user.terminalId !== t.originTerminalId) {
          throw AppError.forbidden('Counter staff can only set the bus and crew of departures leaving from their own terminal.');
        }
        if (b.standInConductorId !== undefined) throw AppError.forbidden('Only a manager or admin can record a stand-in conductor.');
        if (!['scheduled', 'delayed', 'boarding'].includes(t.status)) throw AppError.conflict(`Trip is already ${t.status}.`);
      }
      if (t.status === 'cancelled') throw AppError.conflict('Trip is cancelled');
      if (['departed', 'arrived'].includes(t.status)) {
        // After departure only the stand-in conductor may still be recorded (meeting, 35).
        const other = Object.keys(b).filter((k) => k !== 'standInConductorId');
        if (other.length) throw AppError.conflict(`Trip is already ${t.status}: only the stand-in conductor can still be set`);
        await assertStandInValid(client, b.standInConductorId);
        return one(`UPDATE trips SET stand_in_conductor_id = $2 WHERE id = $1 RETURNING *`, [id, b.standInConductorId ?? null], client);
      }
      await assertConductorValid(client, b.conductorId);
      await assertStandInValid(client, b.standInConductorId);
      if (b.conductorId !== undefined || b.standInConductorId !== undefined) {
        await client.query(
          `UPDATE trips SET conductor_id = $2, stand_in_conductor_id = $3 WHERE id = $1`,
          [id, b.conductorId !== undefined ? b.conductorId : t.conductorId, b.standInConductorId !== undefined ? b.standInConductorId : t.standInConductorId],
        );
      }

      // A different bus, or confirming the planned one: check it (locked, so two saves can't both find it free).
      const confirming = Boolean(b.busId) && !t.busConfirmed;
      if (b.busId && (b.busId !== t.busId || confirming)) {
        const nb = await one(`SELECT layout_id, bus_class, registration_no FROM buses WHERE id = $1 AND is_active FOR UPDATE`, [b.busId], client);
        if (!nb) throw AppError.badRequest(b.busId === t.busId ? `Bus ${t.registrationNo} is inactive: choose another bus` : 'Bus not found or inactive');
        if (nb.layoutId !== t.layoutId) throw AppError.conflict('Replacement bus must have the same seat layout');
        await assertBusFree(client, b.busId, t.departureAt, t.arrivalAt, '', id);
        if (nb.busClass !== t.busClass) {
          warnings.push(`Bus ${nb.registrationNo} is ${nb.busClass}; the tickets on this trip were sold at ${t.busClass} fares.`);
        }
      }
      const driverId = b.driverId !== undefined ? b.driverId : t.driverId;
      const coDriverId = b.coDriverId !== undefined ? b.coDriverId : t.coDriverId;
      if (driverId && coDriverId && driverId === coDriverId) throw AppError.badRequest('Driver and co-driver must differ');
      await assertDriversValid(client, [b.driverId, b.coDriverId]);

      const updated = await one(
        `UPDATE trips SET bus_id = $2, driver_id = $3, co_driver_id = $4, hostess_name = $5 WHERE id = $1 RETURNING *`,
        [id, b.busId ?? t.busId, driverId, coDriverId, b.hostessName !== undefined ? b.hostessName : t.hostessName],
        client,
      );
      // Saving with a bus confirms it.
      if (b.busId && (await busConfirmReady(client))) {
        return one(`UPDATE trips SET bus_confirmed = TRUE WHERE id = $1 RETURNING *`, [id], client);
      }
      return updated;
    });
    await audit({ req, action: 'trip.assignment', entityType: 'trip', entityId: id, newData: b });
    res.json({ data: trip, warnings });
  },
);

const TRANSITIONS = {
  scheduled: ['boarding', 'delayed', 'cancelled'],
  delayed: ['boarding', 'cancelled', 'scheduled'],
  boarding: ['departed', 'delayed', 'cancelled'],
  departed: ['arrived'],
  arrived: [],
  cancelled: [],
};

/**
 * What counter staff may do to a trip's status. The person at the counter is the one who sees the bus, so they
 * update it; a trip has ONE status for the whole journey, so what they may do depends on where their terminal is:
 *   - where the bus STARTS: boarding, delayed (with minutes), back to scheduled, departed;
 *   - a MIDDLE stop: only report how late the bus is (delay minutes; the status itself does not change), until
 *     that terminal's own voucher is generated (after that the bus has left them);
 *   - where the bus ENDS: arrived.
 * Never: cancel a trip (admins), open or close booking, or touch a bus that does not call at their terminal.
 */
async function assertCounterMayChange(client, user, t, b) {
  const mine = user.terminalId;
  if (!mine) throw AppError.forbidden('Your account has no terminal. Ask an admin to set one.');
  if (b.bookingOpen !== undefined) throw AppError.forbidden('Only a manager or admin can open or close booking on a trip.');
  if (b.status === 'cancelled') throw AppError.forbidden('Only admins can cancel trips');

  if (b.status === 'arrived') {
    if (mine !== t.destinationTerminalId) throw AppError.forbidden('Only the terminal where the bus ends (or a manager) can mark it arrived.');
    return;
  }
  if (mine === t.originTerminalId) return; // boarding / delayed / scheduled / departed: the usual order is checked below

  // A middle stop: the delay only.
  const stop = await one(
    `SELECT rs.id, c.name AS city,
            EXISTS (SELECT 1 FROM trip_vouchers v WHERE v.trip_id = $1 AND v.boarding_stop_id = rs.id AND v.status = 'generated') AS voucher_done
     FROM route_stops rs JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
     WHERE rs.route_id = $2 AND rs.terminal_id = $3`,
    [t.id, t.routeId, mine],
    client,
  );
  if (!stop || mine === t.destinationTerminalId) {
    throw AppError.forbidden(stop ? 'At the terminal where the bus ends you can only mark it arrived.' : 'This bus does not call at your terminal.');
  }
  if (b.status !== t.status || b.delayMinutes === undefined) {
    throw AppError.forbidden(`From ${stop.city} you can report how late this bus is. Its status is changed by the terminal it leaves from, or a manager.`);
  }
  if (['arrived', 'cancelled'].includes(t.status)) throw AppError.conflict(`This trip is ${t.status}.`);
  if (stop.voucherDone) throw AppError.conflict(`The ${stop.city} voucher is generated: the bus has left ${stop.city}. The next terminal reports any further delay.`);
}

router.patch(
  '/:id/status',
  ...staff, // counter staff: what assertCounterMayChange allows at their own terminal; everything: managers and up
  validate({
    params: bigIdParam,
    body: z
      .object({
        status: z.enum(['scheduled', 'boarding', 'departed', 'arrived', 'cancelled', 'delayed']),
        delayMinutes: z.number().int().min(0).max(1440).optional(),
        reason: longText(500).optional(),
        bookingOpen: z.boolean().optional(),
      })
      .strict()
      .refine((b) => b.status !== 'cancelled' || (b.reason && b.reason.length >= 3), 'A reason is required to cancel a trip'),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    if (b.status === 'cancelled' && !ADMIN_ROLES.includes(req.user.role)) {
      throw AppError.forbidden('Only admins can cancel trips');
    }

    const result = await withTransaction(async (client) => {
      const confirmed = await confirmedSql('t', client);
      const t = await one(
        `SELECT t.id, t.status, t.route_id, t.conductor_id, t.stand_in_conductor_id, r.origin_terminal_id, r.destination_terminal_id,
                ${confirmed} AS bus_confirmed
         FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = $1 FOR UPDATE OF t`,
        [id],
        client,
      );
      if (!t) throw AppError.notFound('Trip not found');
      if (!MANAGER_ROLES.includes(req.user.role)) await assertCounterMayChange(client, req.user, t, b);
      if (t.status !== b.status && !TRANSITIONS[t.status].includes(b.status)) {
        throw AppError.conflict(`Cannot change trip from ${t.status} to ${b.status}`);
      }
      // The bus does not move until it is confirmed, nor without a conductor.
      if (['boarding', 'departed'].includes(b.status) && t.status !== b.status && !t.busConfirmed) {
        throw AppError.unprocessable(CONFIRM_FIRST);
      }
      if (['boarding', 'departed'].includes(b.status) && !t.conductorId && !t.standInConductorId) {
        throw AppError.unprocessable('Assign a conductor first (Bus & crew). The bus cannot leave without one.');
      }
      // Arrived closes the trip: nothing can be added to a voucher afterwards. A terminal that sold tickets, took
      // load money or loaded parcels must have its voucher first, or that cash would be on no voucher and its
      // parcels could not be received at the destination.
      if (b.status === 'arrived' && t.status !== 'arrived') {
        const missing = await terminalsMissingVoucher(client, id);
        if (missing.length) {
          const names = missing.map((m) => m.city).join(', ');
          throw new AppError(
            422,
            `Generate the terminal voucher for ${names} first. ${missing.length === 1 ? 'That terminal has' : 'Those terminals have'} sales, load or cargo on this bus that are not on a voucher yet. Its counter staff or a manager can generate it (Terminal vouchers); then mark the bus arrived.`,
            'VOUCHER_MISSING',
            missing.map((m) => ({ field: 'status', message: `${m.city}: voucher not generated` })),
          );
        }
      }

      const trip = await one(
        `UPDATE trips SET status = $2::trip_status,
                delay_minutes = COALESCE($3, delay_minutes),
                cancel_reason = CASE WHEN $2::trip_status = 'cancelled' THEN $4 ELSE cancel_reason END,
                -- Departed from the first terminal does NOT close booking: later terminals sell until their voucher.
                booking_open  = CASE WHEN $2::trip_status IN ('arrived','cancelled') THEN FALSE ELSE COALESCE($5, booking_open) END
         WHERE id = $1 RETURNING *`,
        [id, b.status, b.delayMinutes ?? null, b.reason ?? null, b.bookingOpen ?? null],
        client,
      );

      let affectedBookings = 0;
      if (b.status === 'cancelled') {
        // Cancel every live booking; paid ones get a full refund request.
        const { rows: bookings } = await query(
          `UPDATE bookings SET status = 'cancelled', cancel_reason = 'Trip cancelled by operator'
           WHERE trip_id = $1 AND status IN ('pending', 'confirmed') RETURNING id`,
          [id],
          client,
        );
        affectedBookings = bookings.length;
        // Each payment is given back in full, less any refund already recorded against it (a duplicate payment
        // has its own refund): never more than was received.
        await client.query(
          `INSERT INTO refunds (payment_id, booking_id, amount, cancellation_fee, status, reason)
           SELECT p.id, p.booking_id, x.remaining, 0, 'approved', 'Trip cancelled by operator'
           FROM payments p
           CROSS JOIN LATERAL (
             SELECT p.amount - COALESCE((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status <> 'rejected'), 0) AS remaining
           ) x
           WHERE p.booking_id = ANY ($1::uuid[]) AND p.status = 'succeeded' AND x.remaining > 0`,
          [bookings.map((x) => x.id)],
        );
        // Its vouchers are voided; their numbers stay on record.
        await client.query(
          `UPDATE trip_vouchers SET status = 'void', closed_at = now(), closed_reason = 'Trip cancelled: ' || $2::text
           WHERE trip_id = $1 AND status = 'generated'`,
          [id, b.reason],
        );
        // Its cargo lists too: the parcels go back to their terminal to go on another bus.
        if (await cargoListsReady(client)) await voidListsForCancelledTrip(client, { tripId: id, reason: b.reason ?? 'no reason given', user: req.user });
      }
      if (b.status === 'arrived') {
        await client.query(`UPDATE bookings SET status = 'completed' WHERE trip_id = $1 AND status = 'confirmed'`, [id]);
      }
      // A round trip report is made automatically at one moment only: the bus is marked Arrived, either at an origin
      // terminal (Lahore, Multan) or back in the city it started from (Islamabad → DI Khan → Islamabad).
      // Boarding and Departed never make one. Never blocks the change.
      let autoReport = null;
      if (b.status === 'arrived' && t.status !== 'arrived') autoReport = await autoCreateReport(client, { tripId: id, userId: req.user.id });
      return { trip, affectedBookings, autoReport };
    });

    await audit({ req, action: 'trip.status', entityType: 'trip', entityId: id, newData: b });
    if (result.autoReport?.error) req.log?.warn({ tripId: id, err: result.autoReport.error }, 'Automatic round trip report not made');
    res.json({ data: result.trip, affectedBookings: result.affectedBookings, autoReport: result.autoReport });
  },
);

/** Passenger manifest for boarding staff. */
router.get('/:id/manifest', ...staff, validate({ params: bigIdParam }), async (req, res) => {
  const { rows } = await query(
    `SELECT tk.id AS ticket_id, tk.ticket_no, ls.seat_number, tk.passenger_name, tk.passenger_gender,
            tk.passenger_cnic, tk.passenger_phone, tk.status, tk.boarded_at,
            bk.pnr, bt.name AS boarding_terminal, dt.name AS dropping_terminal
     FROM tickets tk
     JOIN bookings bk     ON bk.id = tk.booking_id
     JOIN layout_seats ls ON ls.id = tk.seat_id
     JOIN route_stops bs  ON bs.id = bk.boarding_stop_id JOIN terminals bt ON bt.id = bs.terminal_id
     JOIN route_stops ds  ON ds.id = bk.dropping_stop_id JOIN terminals dt ON dt.id = ds.terminal_id
     WHERE tk.trip_id = $1 AND tk.status IN ('confirmed', 'boarded', 'no_show')
     ORDER BY ${seatOrder('ls')}`,
    [req.valid.params.id],
  );
  res.json({ data: rows });
});

export default router;
