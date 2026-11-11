/**
 * The conductor's screen (meeting notes 13, 14, 29, 35):
 *   GET  /conductor/voucher/:no               open the trip of a voucher number: seat map, passengers, stops
 *   POST /conductor/trips/:tripId/passengers  book a road passenger on an empty seat (fare typed in, or free)
 *   POST /conductor/tickets/:ticketId/no-show passenger did not travel, with a note
 * Who may use it: the trip's conductor (their login is linked on the Conductors page), the trip's stand-in staff
 * member, and managers and admins for any trip.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, EMPLOYEE_ROLES, MANAGER_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { bigIdParam, gender, intId, personName, phone, text, uuid } from '../../utils/schemas.js';
import { loadTrip } from '../tripvouchers/tripVouchers.service.js';

const router = Router();
router.use(requireAuth, requireRole(...EMPLOYEE_ROLES));

const ACTIVE = `('held', 'reserved', 'confirmed', 'boarded')`;

/** The trip's conductor, its stand-in, or a manager / admin. */
function assertTripAccess(user, trip) {
  if (MANAGER_ROLES.includes(user.role)) return;
  if (trip.conductorUserId && trip.conductorUserId === user.id) return;
  if (trip.standInConductorId && trip.standInConductorId === user.id) return;
  throw AppError.forbidden('This voucher belongs to a trip you are not the conductor of.');
}

/** Where road passengers board: the last terminal whose voucher has been generated. */
async function lastVoucherStop(tripId, stops, client) {
  const { rows } = await query(
    `SELECT boarding_stop_id FROM trip_vouchers WHERE trip_id = $1 AND status = 'generated'`,
    [tripId],
    client,
  );
  const ids = new Set(rows.map((r) => r.boardingStopId));
  return [...stops].reverse().find((s) => ids.has(s.id)) ?? null;
}

async function tripView(tripId, user) {
  const loaded = await loadTrip(tripId);
  if (!loaded) throw AppError.notFound('Trip not found');
  const { trip, stops } = loaded;
  assertTripAccess(user, trip);
  const stopById = new Map(stops.map((s) => [s.id, s]));
  const [seats, tickets, vouchers] = await Promise.all([
    query(`SELECT id, seat_number, row_no, col_no, deck, kind, is_bookable FROM layout_seats WHERE layout_id = $1 ORDER BY deck, row_no, col_no`, [trip.layoutId]),
    query(
      `SELECT tk.id, tk.seat_id, tk.passenger_name, tk.passenger_gender, tk.passenger_phone, tk.fare_amount, tk.status,
              tk.is_free, tk.no_show_note, bk.boarding_stop_id, bk.dropping_stop_id, bk.channel::text AS channel, bk.pnr
       FROM tickets tk JOIN bookings bk ON bk.id = tk.booking_id
       WHERE tk.trip_id = $1 AND tk.status IN ('held', 'reserved', 'confirmed', 'boarded', 'no_show')
       ORDER BY tk.created_at`,
      [tripId],
    ),
    query(`SELECT id, voucher_no, boarding_stop_id, terminal_name, status, generated_at FROM trip_vouchers WHERE trip_id = $1 AND status = 'generated' ORDER BY generated_at`, [tripId]),
  ]);
  const from = await lastVoucherStop(tripId, stops);
  const passengerOf = (t) => ({
    ticketId: t.id,
    name: t.passengerName,
    gender: t.passengerGender,
    phone: t.passengerPhone,
    from: stopById.get(t.boardingStopId)?.city ?? '?',
    to: stopById.get(t.droppingStopId)?.city ?? '?',
    toStopOrder: stopById.get(t.droppingStopId)?.stopOrder ?? 0,
    fare: Number(t.fareAmount) || 0,
    isFree: t.isFree,
    status: t.status,
    paid: ['confirmed', 'boarded'].includes(t.status),
    onRoad: t.channel === 'on_road',
    noShowNote: t.noShowNote,
    pnr: t.pnr,
  });
  return {
    trip: {
      id: trip.id,
      status: trip.status,
      routeName: trip.routeName,
      departureAt: trip.departureAt,
      busNo: trip.registrationNo,
      driverName: trip.driverName,
      conductorName: trip.conductorName ?? trip.standInConductorName,
    },
    stops: stops.map((s) => ({ id: s.id, city: s.city, stopOrder: s.stopOrder, time: s.time, voucherGenerated: vouchers.rows.some((v) => v.boardingStopId === s.id) })),
    vouchers: vouchers.rows,
    // Road passengers board after the last terminal with a voucher and may go to any later stop.
    roadBooking: from
      ? { fromStopId: from.id, fromCity: from.city, destinations: stops.filter((s) => s.stopOrder > from.stopOrder && s.isDroppingPoint).map((s) => ({ id: s.id, city: s.city })) }
      : null,
    seats: seats.rows.map((s) => {
      const t = tickets.rows.find((x) => x.seatId === s.id && x.status !== 'no_show');
      const noShow = tickets.rows.find((x) => x.seatId === s.id && x.status === 'no_show');
      return {
        seatId: s.id, seatNumber: s.seatNumber, rowNo: s.rowNo, colNo: s.colNo, deck: s.deck, bookable: s.isBookable && s.kind !== 'driver' && s.kind !== 'blocked',
        passenger: t ? passengerOf(t) : null,
        noShow: noShow ? passengerOf(noShow) : null,
      };
    }),
    passengers: tickets.rows.map(passengerOf).sort((a, b) => a.toStopOrder - b.toStopOrder),
    loadedAt: new Date().toISOString(),
  };
}

router.get('/voucher/:no', validate({ params: z.object({ no: z.string().regex(/^\d{10}$/, 'Voucher numbers have 10 digits') }).strict() }), async (req, res) => {
  const v = await one(
    `SELECT v.id, v.trip_id, v.status, v.voucher_no, r.voucher_no AS replaced_by_no
     FROM trip_vouchers v LEFT JOIN trip_vouchers r ON r.replaces_id = v.id WHERE v.voucher_no = $1`,
    [req.valid.params.no],
  );
  if (!v) throw AppError.notFound('No voucher with that number. Check the number on the slip.');
  if (v.status === 'void') throw AppError.unprocessable('This voucher was voided (the trip was cancelled).');
  const view = await tripView(v.tripId, req.user);
  res.set('Cache-Control', 'no-store');
  res.json({ data: { ...view, voucher: { id: v.id, voucherNo: v.voucherNo, status: v.status, replacedByNo: v.replacedByNo } } });
});

router.post(
  '/trips/:id/passengers',
  validate({
    params: bigIdParam,
    body: z
      .object({
        seatId: intId,
        name: personName,
        gender,
        phone: phone.optional(),
        destinationStopId: intId,
        fare: z.number().int().min(0).max(100_000),
        free: z.boolean().default(false),
      })
      .strict()
      .refine((b) => b.free || b.fare > 0, 'Enter the fare collected, or mark the passenger as free'),
  }),
  async (req, res) => {
    const tripId = req.valid.params.id;
    const b = req.valid.body;
    const out = await withTransaction(async (client) => {
      // Same lock as counter bookings and voucher generation.
      const lock = await one(`SELECT id, status FROM trips WHERE id = $1 FOR UPDATE`, [tripId], client);
      if (!lock) throw AppError.notFound('Trip not found');
      if (['cancelled', 'arrived'].includes(lock.status)) throw AppError.unprocessable(`This trip is ${lock.status}.`);
      const { trip, stops } = await loadTrip(tripId, client);
      assertTripAccess(req.user, trip);
      const from = await lastVoucherStop(tripId, stops, client);
      if (!from) throw AppError.unprocessable('Road passengers can be added once the first terminal has generated its voucher.');
      const to = stops.find((s) => s.id === b.destinationStopId);
      if (!to || to.stopOrder <= from.stopOrder) throw AppError.badRequest(`Choose a destination after ${from.city}.`);
      const seat = await one(`SELECT id FROM layout_seats WHERE id = $1 AND layout_id = $2 AND is_bookable`, [b.seatId, trip.layoutId], client);
      if (!seat) throw AppError.badRequest('That seat is not on this bus.');
      const taken = await one(`SELECT id FROM tickets WHERE trip_id = $1 AND seat_id = $2 AND status IN ${ACTIVE}`, [tripId, b.seatId], client);
      if (taken) throw AppError.conflict('That seat is already taken. Refresh and choose an empty seat.');

      const fare = b.free ? 0 : b.fare;
      const booking = await one(
        `INSERT INTO bookings (trip_id, boarding_stop_id, dropping_stop_id, contact_name, contact_phone, channel, booked_by_agent_id,
                               subtotal, discount_amount, currency, notes)
         VALUES ($1, $2, $3, $4, $5, 'on_road', $6, $7, 0, 'PKR', $8) RETURNING id, pnr`,
        [tripId, from.id, to.id, b.name, b.phone ?? '-', req.user.id, fare, b.free ? 'Road passenger, travelled free' : 'Road passenger'],
        client,
      );
      // Seat rules (bus, bookable, side-by-side gender rule) are checked by the ticket triggers.
      const ticket = await one(
        `INSERT INTO tickets (booking_id, trip_id, seat_id, passenger_name, passenger_gender, passenger_phone, fare_amount, status, is_free, added_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'held', $8, $9) RETURNING id`,
        [booking.id, tripId, b.seatId, b.name, b.gender, b.phone ?? null, fare, b.free, req.user.id],
        client,
      );
      if (fare > 0) {
        await client.query(
          `INSERT INTO payments (booking_id, method, status, amount, currency, received_by, paid_at)
           VALUES ($1, 'cash', 'succeeded', $2, 'PKR', $3, now())`,
          [booking.id, fare, req.user.id],
        );
      }
      await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [booking.id]);
      await audit({ req, client, action: 'conductor.road_passenger', entityType: 'trip', entityId: tripId, newData: { ticketId: ticket.id, pnr: booking.pnr, from: from.city, to: to.city, fare, free: b.free } });
      return { ticketId: ticket.id, pnr: booking.pnr };
    });
    res.status(201).json({ data: out });
  },
);

router.post(
  '/tickets/:ticketId/no-show',
  validate({ params: z.object({ ticketId: uuid }).strict(), body: z.object({ note: text(2, 300) }).strict() }),
  async (req, res) => {
    const out = await withTransaction(async (client) => {
      const t = await one(`SELECT id, trip_id, status FROM tickets WHERE id = $1 FOR UPDATE`, [req.valid.params.ticketId], client);
      if (!t) throw AppError.notFound('Passenger not found');
      const loaded = await loadTrip(t.tripId, client);
      assertTripAccess(req.user, loaded.trip);
      if (!['confirmed', 'boarded'].includes(t.status)) throw AppError.unprocessable('Only a paid passenger can be marked as not travelled.');
      await client.query(`UPDATE tickets SET status = 'no_show', no_show_note = $2 WHERE id = $1`, [t.id, req.valid.body.note]);
      await audit({ req, client, action: 'conductor.no_show', entityType: 'trip', entityId: t.tripId, newData: { ticketId: t.id, note: req.valid.body.note } });
      return { ticketId: t.id };
    });
    res.json({ data: out });
  },
);

export default router;
