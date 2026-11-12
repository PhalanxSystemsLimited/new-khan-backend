import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, STAFF_ROLES, isStaff } from '../../middleware/auth.js';
import { bookingLimiter, lookupLimiter, otpLimiter } from '../../middleware/rateLimit.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { offsetOf, paged } from '../../utils/sql.js';
import {
  bigId, cnic, email, gender, intId, longText, pagination, personName, phone, uuid, uuidParam,
} from '../../utils/schemas.js';
import {
  assertCanAccess, cancelBooking, counterCancel, createBooking, getBookingDetail, getCancellationQuote, getCounterQuote,
  sendCounterCode,
} from './bookings.service.js';
import { reconcileSafepayBooking } from '../payments/payments.routes.js';

const router = Router();

/**
 * One row per booking for My bookings: journey, boarding time, seats and amount. $1 is the signed-in user;
 * counter_sale marks a booking they made as staff for someone else (it is not on their own account).
 */
const LIST_SELECT = `
  SELECT bk.id, bk.pnr, bk.status, bk.total_amount, bk.currency, bk.created_at, bk.hold_expires_at, bk.expiry_seen_at,
         bk.user_id IS DISTINCT FROM $1 AS counter_sale,
         CASE WHEN bk.user_id IS DISTINCT FROM $1 THEN bk.contact_name END AS customer_name,
         EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = bk.id
                   AND p.status IN ('succeeded', 'refunded', 'partially_refunded')) AS payment_received,
         r.name AS route_name, t.departure_at,
         bt.name AS boarding_terminal, dt.name AS dropping_terminal,
         t.departure_at + make_interval(mins => bs.minutes_from_origin) AS boarding_at,
         (SELECT count(*) FROM tickets tk WHERE tk.booking_id = bk.id)::int AS seats,
         (SELECT array_agg(ls.seat_number ORDER BY ls.seat_number) FROM tickets tk JOIN layout_seats ls ON ls.id = tk.seat_id
           WHERE tk.booking_id = bk.id) AS seat_numbers
  FROM bookings bk
  JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
  JOIN route_stops bs ON bs.id = bk.boarding_stop_id JOIN terminals bt ON bt.id = bs.terminal_id
  JOIN route_stops ds ON ds.id = bk.dropping_stop_id JOIN terminals dt ON dt.id = ds.terminal_id`;

/**
 * Before showing bookings, settle any whose Safepay payment went through but was never recorded. Only bookings
 * that are pending or expired AND have an unsettled Safepay payment are checked, so this costs nothing otherwise.
 */
async function reconcileUnsettled(where, params) {
  const { rows } = await query(
    `SELECT DISTINCT bk.id FROM bookings bk JOIN payments p ON p.booking_id = bk.id
     WHERE ${where} AND bk.status IN ('pending', 'expired')
       AND p.gateway = 'safepay' AND p.status IN ('initiated', 'pending') AND p.gateway_txn_id IS NOT NULL
     LIMIT 10`,
    params,
  );
  for (const r of rows) await reconcileSafepayBooking(r.id);
}

const passengerSchema = z
  .object({
    seatId: intId,
    name: personName,
    gender,
    age: z.number().int().min(0).max(120).optional(),
    cnic: cnic.optional(),
    phone, // every passenger's mobile number is required
  })
  .strict();

const createSchema = z
  .object({
    tripId: bigId,
    boardingStopId: intId,
    droppingStopId: intId,
    contact: z.object({ name: personName, phone, email: email.optional() }).strict(),
    // The booking holder's CNIC: checked at the counter before a cash refund. For customers it is always the
    // account's CNIC (this value is used, and saved to the account, only when the account has none yet).
    holderCnic: cnic.optional(),
    passengers: z.array(passengerSchema).min(1).max(20),
    promoCode: z.string().trim().regex(/^[A-Za-z0-9_-]{3,30}$/, 'Invalid promo code').optional(),
    channel: z.enum(['web', 'mobile_app', 'counter', 'phone', 'agent']).optional(),
    // staff only
    customerId: uuid.optional(),
    notes: longText(500).optional(),
  })
  .strict()
  .refine((b) => b.boardingStopId !== b.droppingStopId, 'Boarding and dropping stops must differ')
  .refine((b) => new Set(b.passengers.map((p) => p.seatId)).size === b.passengers.length, 'Each seat can be selected only once');

router.post('/', requireAuth, bookingLimiter, validate({ body: createSchema }), async (req, res) => {
  const body = req.valid.body;
  if (!isStaff(req.user) && (body.customerId || body.notes)) {
    throw AppError.forbidden('customerId and notes can only be set by staff');
  }
  const booking = await createBooking(req.user, body);
  res.status(201).json({ data: booking });
});

/**
 * The signed-in user's bookings, newest first, with the journey details a list needs: bookings on their account
 * plus, for staff, the counter sales they made for walk-in customers (those have no account of their own).
 */
const MINE = '(bk.user_id = $1 OR bk.booked_by_agent_id = $1)';
router.get('/me', requireAuth, validate({ query: pagination.strict() }), async (req, res) => {
  const q = req.valid.query;
  // Settle anything already paid on Safepay first, so the list never shows a paid booking as pending.
  await reconcileUnsettled(MINE, [req.user.id]);

  const total = (await one(`SELECT count(*)::int AS n FROM bookings bk WHERE ${MINE}`, [req.user.id])).n;
  const { rows } = await query(
    `${LIST_SELECT} WHERE ${MINE} ORDER BY bk.created_at DESC LIMIT $2 OFFSET $3`,
    [req.user.id, q.limit, offsetOf(q)],
  );
  res.json(paged(rows, q, total));
});

/**
 * Public lookup by mobile number alone: every booking made with that contact number, newest first.
 * Deliberately reduced (no passenger names, CNICs, emails or payment details): enough to recognise a trip
 * and read its booking number. Rate limited like the PNR lookup.
 */
router.get(
  '/lookup-phone',
  lookupLimiter,
  validate({ query: z.object({ phone }).strict() }),
  async (req, res) => {
    await reconcileUnsettled('bk.contact_phone = $1', [req.valid.query.phone]);
    const { rows } = await query(
      `SELECT bk.pnr, bk.status, bk.total_amount, bk.currency, bk.created_at, r.name AS route_name,
              bt.name AS boarding_terminal, dt.name AS dropping_terminal,
              t.departure_at + make_interval(mins => bs.minutes_from_origin) AS boarding_at,
              (SELECT array_agg(ls.seat_number ORDER BY ls.seat_number) FROM tickets tk JOIN layout_seats ls ON ls.id = tk.seat_id
                WHERE tk.booking_id = bk.id) AS seat_numbers
       FROM bookings bk
       JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
       JOIN route_stops bs ON bs.id = bk.boarding_stop_id JOIN terminals bt ON bt.id = bs.terminal_id
       JOIN route_stops ds ON ds.id = bk.dropping_stop_id JOIN terminals dt ON dt.id = ds.terminal_id
       WHERE bk.contact_phone = $1
       ORDER BY bk.created_at DESC LIMIT 20`,
      [req.valid.query.phone],
    );
    res.json({ data: rows });
  },
);

/**
 * Public lookup: requires both PNR and the contact phone used at booking.
 * Returns a reduced view (no CNICs, no payment details).
 */
router.get(
  '/lookup',
  lookupLimiter,
  validate({
    query: z
      .object({ pnr: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6,10}$/), phone })
      .strict(),
  }),
  async (req, res) => {
    const { pnr, phone: tel } = req.valid.query;
    const found = await one(`SELECT id FROM bookings WHERE pnr = $1 AND contact_phone = $2`, [pnr, tel]);
    if (!found) throw AppError.notFound('No booking found for this PNR and phone number');
    await reconcileUnsettled('bk.id = $1', [found.id]);
    const b = await getBookingDetail(found.id);
    const paid = await one(`SELECT 1 FROM payments WHERE booking_id = $1 AND status IN ('succeeded', 'refunded', 'partially_refunded') LIMIT 1`, [found.id]);
    res.json({
      data: {
        pnr: b.pnr,
        status: b.status,
        routeName: b.routeName,
        boardingTerminal: b.boardingTerminal,
        droppingTerminal: b.droppingTerminal,
        boardingAt: b.boardingAt,
        tripStatus: b.tripStatus,
        totalAmount: b.totalAmount,
        currency: b.currency,
        paymentReceived: Boolean(paid),
        tickets: b.tickets.map((t) => ({ ticketNo: t.ticketNo, seatNumber: t.seatNumber, passengerName: t.passengerName, status: t.status })),
      },
    });
  },
);

// ---- Staff search ----
router.get(
  '/',
  requireAuth,
  requireRole(...STAFF_ROLES),
  validate({
    query: pagination
      .extend({
        tripId: bigId.optional(),
        pnr: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,10}$/).optional(),
        phone: phone.optional(),
        status: z.enum(['pending', 'confirmed', 'cancelled', 'completed', 'expired', 'refunded']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const params = [q.tripId ?? null, q.pnr ?? null, q.phone ?? null, q.status ?? null];
    const where = `WHERE ($1::bigint IS NULL OR bk.trip_id = $1)
                     AND ($2::text IS NULL OR bk.pnr = $2)
                     AND ($3::text IS NULL OR bk.contact_phone = $3)
                     AND ($4::booking_status IS NULL OR bk.status = $4)`;
    const total = (await one(`SELECT count(*)::int AS n FROM bookings bk ${where}`, params)).n;
    const { rows } = await query(
      `SELECT bk.id, bk.pnr, bk.status, bk.channel, bk.contact_name, bk.contact_phone, bk.total_amount,
              bk.created_at, t.departure_at, r.name AS route_name
       FROM bookings bk JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id
       ${where} ORDER BY bk.created_at DESC LIMIT $5 OFFSET $6`,
      [...params, q.limit, offsetOf(q)],
    );
    res.json(paged(rows, q, total));
  },
);

router.get('/:id', requireAuth, validate({ params: uuidParam }), async (req, res) => {
  let booking = await getBookingDetail(req.valid.params.id);
  assertCanAccess(booking, req.user);
  // Paid on Safepay but not recorded yet (customer closed the checkout tab, webhook can't reach this server)?
  // An expired one that was paid gets its payment recorded and a refund queued (its seats were already released).
  if (booking.status === 'pending' || booking.status === 'expired') {
    await reconcileSafepayBooking(booking.id);
    booking = await getBookingDetail(booking.id);
  }
  res.json({ data: booking });
});

/**
 * The customer has seen the "your reservation expired" notice for these bookings: don't show it again on any
 * device. Only the owner's own unpaid holds whose time has run out are marked; anything else is ignored.
 */
router.post(
  '/expiry-seen',
  requireAuth,
  validate({ body: z.object({ ids: z.array(uuid).min(1).max(50) }).strict() }),
  async (req, res) => {
    const { rowCount } = await query(
      `UPDATE bookings SET expiry_seen_at = now()
       WHERE id = ANY($1::uuid[]) AND (user_id = $2 OR booked_by_agent_id = $2) AND expiry_seen_at IS NULL
         AND status IN ('pending', 'expired') AND hold_expires_at < now()`,
      [req.valid.body.ids, req.user.id],
    );
    res.json({ data: { marked: rowCount } });
  },
);

router.get('/:id/cancel-quote', requireAuth, validate({ params: uuidParam }), async (req, res) => {
  res.json({ data: await getCancellationQuote(req.valid.params.id, req.user) });
});

router.post(
  '/:id/cancel',
  requireAuth,
  validate({ params: uuidParam, body: z.object({ reason: longText(500).optional() }).strict() }),
  async (req, res) => {
    const result = await cancelBooking(req.valid.params.id, req.user, req.valid.body.reason);
    await audit({ req, action: 'booking.cancel', entityType: 'booking', entityId: req.valid.params.id, newData: { reason: req.valid.body.reason, refund: result.refund } });
    res.json({ data: result.booking, refund: result.refund });
  },
);

// ---- Counter cancellation (any staff member at a counter) ----
const counterCancelSchema = z
  .object({
    cnic: cnic.optional(),
    code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits').optional(),
    reason: longText(500).optional(),
  })
  .strict();

router.get('/:id/counter-quote', requireAuth, requireRole(...STAFF_ROLES), validate({ params: uuidParam }), async (req, res) => {
  res.json({ data: await getCounterQuote(req.valid.params.id, req.user) });
});

router.post(
  '/:id/counter-code',
  requireAuth,
  requireRole(...STAFF_ROLES),
  otpLimiter,
  validate({ params: uuidParam }),
  async (req, res) => {
    const result = await sendCounterCode(req.valid.params.id, req.user);
    await audit({ req, action: 'booking.counter_code', entityType: 'booking', entityId: req.valid.params.id, newData: { sentTo: result.sentTo } });
    res.json({ data: result });
  },
);

router.post(
  '/:id/counter-cancel',
  requireAuth,
  requireRole(...STAFF_ROLES),
  validate({ params: uuidParam, body: counterCancelSchema }),
  async (req, res) => {
    const id = req.valid.params.id;
    try {
      const result = await counterCancel(id, req.user, req.valid.body);
      await audit({
        req,
        action: 'booking.counter_cancel',
        entityType: 'booking',
        entityId: id,
        newData: { reason: req.valid.body.reason, refund: result.refund, refundHow: result.refundHow, identityCheck: result.identityCheck },
      });
      res.json({ data: result.booking, refund: result.refund, refundHow: result.refundHow });
    } catch (err) {
      // A wrong CNIC or code is kept in the activity log: repeated failures are worth a look.
      if (err.code === 'IDENTITY_MISMATCH') {
        // Which check failed, never the CNIC or code that was typed.
        const check = req.valid.body.cnic ? 'cnic' : req.valid.body.code ? 'sms_code' : 'none';
        await audit({ req, action: 'booking.counter_identity_failed', entityType: 'booking', entityId: id, newData: { check, message: err.message } }).catch(() => {});
      }
      throw err;
    }
  },
);

router.post(
  '/:id/review',
  requireAuth,
  validate({
    params: uuidParam,
    body: z.object({ rating: z.number().int().min(1).max(5), comment: longText(1000).optional() }).strict(),
  }),
  async (req, res) => {
    const bk = await one(
      `SELECT bk.id, bk.user_id, bk.trip_id, bk.status FROM bookings bk WHERE bk.id = $1`,
      [req.valid.params.id],
    );
    if (!bk || bk.userId !== req.user.id) throw AppError.notFound('Booking not found');
    if (bk.status !== 'completed') throw AppError.unprocessable('You can review a trip only after it is completed');
    const review = await one(
      `INSERT INTO reviews (booking_id, user_id, trip_id, rating, comment) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [bk.id, req.user.id, bk.tripId, req.valid.body.rating, req.valid.body.comment ?? null],
    );
    res.status(201).json({ data: review });
  },
);

// ---- Tickets (boarding) ----
export const ticketsRouter = Router();

ticketsRouter.post(
  '/:id/board',
  requireAuth,
  requireRole(...STAFF_ROLES),
  validate({ params: uuidParam }),
  async (req, res) => {
    const t = await one(
      `UPDATE tickets tk SET status = 'boarded', boarded_at = now()
       FROM trips t
       WHERE tk.id = $1 AND t.id = tk.trip_id AND tk.status = 'confirmed' AND t.status IN ('boarding', 'delayed', 'scheduled')
       RETURNING tk.id, tk.ticket_no, tk.status, tk.boarded_at`,
      [req.valid.params.id],
    );
    if (!t) throw AppError.unprocessable('Ticket not found, not confirmed, or trip is not boarding');
    await audit({ req, action: 'ticket.board', entityType: 'ticket', entityId: t.id, newData: { ticketNo: t.ticketNo, status: t.status, boardedAt: t.boardedAt } });
    res.json({ data: t });
  },
);

export default router;
