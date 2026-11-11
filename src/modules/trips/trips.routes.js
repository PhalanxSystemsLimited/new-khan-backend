import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, requireAuth, requireRole, isStaff, ADMIN_ROLES, MANAGER_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { env } from '../../config/env.js';
import { autoCreateReport, closePreviousRoundTrip } from '../roundtrips/roundtrips.sync.js';
import { expireStaleSoon } from '../../jobs/expireBookings.js';
import { searchLimiter } from '../../middleware/rateLimit.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { bigIdParam, busClass, intId, isoDate, isoDateTime, longText, personName } from '../../utils/schemas.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];
const staff = [requireAuth, requireRole(...STAFF_ROLES)];
const manager = [requireAuth, requireRole(...MANAGER_ROLES)];

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
    routeId: intId,
    busId: intId,
    driverId: intId.optional(),
    coDriverId: intId.optional(),
    conductorId: intId.optional(),
    hostessName: personName.optional(),
    departureAt: isoDateTime,
    // Kept for older clients; online booking now closes ONLINE_CUTOFF_MINUTES before the bus reaches each terminal.
    bookingCloseMinutes: z.number().int().min(0).max(720).default(60),
  })
  .strict()
  .refine((t) => !t.coDriverId || t.coDriverId !== t.driverId, 'Driver and co-driver must differ');

async function assertBusFree(client, busId, departureAt, arrivalAt, excludeTripId = null) {
  const clash = await one(
    `SELECT id FROM trips
     WHERE bus_id = $1 AND status NOT IN ('cancelled', 'arrived')
       AND tstzrange(departure_at, arrival_at) && tstzrange($2::timestamptz, $3::timestamptz)
       AND ($4::bigint IS NULL OR id <> $4)
     LIMIT 1`,
    [busId, departureAt, arrivalAt, excludeTripId],
    client,
  );
  if (clash) throw AppError.conflict(`Bus is already assigned to trip ${clash.id} at that time`);
}

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

  const trip = await withTransaction(async (client) => {
    const route = await one(`SELECT est_duration_minutes FROM routes WHERE id = $1 AND is_active`, [b.routeId], client);
    if (!route?.estDurationMinutes) throw AppError.badRequest('Route not found, inactive, or missing duration');
    const bus = await one(`SELECT id FROM buses WHERE id = $1 AND is_active FOR UPDATE`, [b.busId], client);
    if (!bus) throw AppError.badRequest('Bus not found or inactive');

    const arrivalAt = new Date(Date.parse(b.departureAt) + route.estDurationMinutes * 60_000).toISOString();
    await assertBusFree(client, b.busId, b.departureAt, arrivalAt);
    await assertDriversValid(client, [b.driverId, b.coDriverId]);
    await assertConductorValid(client, b.conductorId);

    const trip = await one(
      `INSERT INTO trips (route_id, bus_id, driver_id, co_driver_id, hostess_name, departure_at, arrival_at, booking_closes_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $6::timestamptz - make_interval(mins => $8)) RETURNING *`,
      [b.routeId, b.busId, b.driverId ?? null, b.coDriverId ?? null, b.hostessName ?? null, b.departureAt, arrivalAt, b.bookingCloseMinutes],
      client,
    );
    // Separate statement so creating trips keeps working on a database without the conductor column.
    if (b.conductorId) return one(`UPDATE trips SET conductor_id = $2 WHERE id = $1 RETURNING *`, [trip.id, b.conductorId], client);
    return trip;
  });
  await audit({ req, action: 'trip.create', entityType: 'trip', entityId: trip.id, newData: trip });
  res.status(201).json({ data: trip });
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
    const { rows } = await query(
      `SELECT t.*, r.name AS route_name, b.registration_no, d.full_name AS driver_name,
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
       WHERE (t.departure_at AT TIME ZONE 'Asia/Karachi')::date = $1::date
         AND ($2::int IS NULL OR t.route_id = $2)
         AND ($3::trip_status IS NULL OR t.status = $3)
       ORDER BY t.departure_at`,
      [q.date, q.routeId ?? null, q.status ?? null],
    );
    res.json({ data: rows });
  },
);

/** Assign bus / crew. Bus change is only allowed if the new bus uses the same seat layout. */
router.patch(
  '/:id/assignment',
  ...manager,
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
    const trip = await withTransaction(async (client) => {
      const t = await one(
        `SELECT t.*, bu.layout_id FROM trips t JOIN buses bu ON bu.id = t.bus_id WHERE t.id = $1 FOR UPDATE OF t`,
        [id],
        client,
      );
      if (!t) throw AppError.notFound('Trip not found');
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

      if (b.busId && b.busId !== t.busId) {
        const nb = await one(`SELECT layout_id FROM buses WHERE id = $1 AND is_active`, [b.busId], client);
        if (!nb) throw AppError.badRequest('Bus not found or inactive');
        if (nb.layoutId !== t.layoutId) throw AppError.conflict('Replacement bus must have the same seat layout');
        await assertBusFree(client, b.busId, t.departureAt, t.arrivalAt, id);
      }
      const driverId = b.driverId !== undefined ? b.driverId : t.driverId;
      const coDriverId = b.coDriverId !== undefined ? b.coDriverId : t.coDriverId;
      if (driverId && coDriverId && driverId === coDriverId) throw AppError.badRequest('Driver and co-driver must differ');
      await assertDriversValid(client, [b.driverId, b.coDriverId]);

      return one(
        `UPDATE trips SET bus_id = $2, driver_id = $3, co_driver_id = $4, hostess_name = $5 WHERE id = $1 RETURNING *`,
        [id, b.busId ?? t.busId, driverId, coDriverId, b.hostessName !== undefined ? b.hostessName : t.hostessName],
        client,
      );
    });
    await audit({ req, action: 'trip.assignment', entityType: 'trip', entityId: id, newData: b });
    res.json({ data: trip });
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

router.patch(
  '/:id/status',
  ...staff, // counter staff: only "arrived", at their own terminal (checked below); everything else: managers and up
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
      const t = await one(
        `SELECT t.id, t.status, t.conductor_id, t.stand_in_conductor_id, r.destination_terminal_id
         FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id = $1 FOR UPDATE OF t`,
        [id],
        client,
      );
      if (!t) throw AppError.notFound('Trip not found');
      if (!MANAGER_ROLES.includes(req.user.role)) {
        // Counter staff see the bus come in: they may mark Arrived for buses ending at their own terminal, nothing else.
        if (b.status !== 'arrived' || !req.user.terminalId || req.user.terminalId !== t.destinationTerminalId) {
          throw AppError.forbidden('Counter staff can only mark buses as arrived at their own terminal.');
        }
      }
      if (t.status !== b.status && !TRANSITIONS[t.status].includes(b.status)) {
        throw AppError.conflict(`Cannot change trip from ${t.status} to ${b.status}`);
      }
      // The bus does not move without a conductor.
      if (['boarding', 'departed'].includes(b.status) && !t.conductorId && !t.standInConductorId) {
        throw AppError.unprocessable('Assign a conductor first (Bus & crew). The bus cannot leave without one.');
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
        await client.query(
          `INSERT INTO refunds (payment_id, booking_id, amount, cancellation_fee, status, reason)
           SELECT p.id, p.booking_id, p.amount, 0, 'approved', 'Trip cancelled by operator'
           FROM payments p
           WHERE p.booking_id = ANY ($1::uuid[]) AND p.status = 'succeeded'`,
          [bookings.map((x) => x.id)],
        );
        // Its vouchers are voided; their numbers stay on record.
        await client.query(
          `UPDATE trip_vouchers SET status = 'void', closed_at = now(), closed_reason = 'Trip cancelled: ' || $2::text
           WHERE trip_id = $1 AND status = 'generated'`,
          [id, b.reason],
        );
      }
      if (b.status === 'arrived') {
        await client.query(`UPDATE bookings SET status = 'completed' WHERE trip_id = $1 AND status = 'confirmed'`, [id]);
      }
      // Round trip reports made automatically: arriving at an origin terminal (Lahore, Multan) closes the bus's
      // round trip; leaving an origin again closes a round trip nobody marked as arrived. Never blocks the change.
      let autoReport = null;
      if (b.status === 'arrived' && t.status !== 'arrived') autoReport = await autoCreateReport(client, { tripId: id, userId: req.user.id });
      if (['boarding', 'departed'].includes(b.status)) autoReport = await closePreviousRoundTrip(client, { tripId: id, userId: req.user.id });
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
     ORDER BY ls.row_no, ls.col_no`,
    [req.valid.params.id],
  );
  res.json({ data: rows });
});

export default router;
