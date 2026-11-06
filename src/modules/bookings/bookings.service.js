import { createHash, randomInt } from 'node:crypto';
import { query, one, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { isStaff } from '../../middleware/auth.js';
import { cnicDigits, cnicDisplay, cnicMasked } from '../../utils/cnic.js';
import { sendSms } from '../../utils/sms.js';
import { findFare } from '../fares/fares.service.js';

const MAX_PENDING_PER_USER = 3;
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------
export async function getBookingDetail(id, client) {
  const booking = await one(
    `SELECT bk.id, bk.pnr, bk.user_id, bk.trip_id, bk.status, bk.channel, bk.contact_name, bk.contact_phone,
            bk.contact_email, bk.subtotal, bk.discount_amount, bk.tax_amount, bk.total_amount, bk.currency,
            bk.hold_expires_at, bk.confirmed_at, bk.cancelled_at, bk.cancel_reason, bk.created_at, bk.holder_cnic,
            r.name AS route_name, t.departure_at AS trip_departure_at, t.status AS trip_status, b.bus_class,
            bt.name AS boarding_terminal, dt.name AS dropping_terminal,
            t.departure_at + make_interval(mins => bs.minutes_from_origin) AS boarding_at,
            t.departure_at + make_interval(mins => ds.minutes_from_origin) AS dropping_at
     FROM bookings bk
     JOIN trips t        ON t.id = bk.trip_id
     JOIN routes r       ON r.id = t.route_id
     JOIN buses b        ON b.id = t.bus_id
     JOIN route_stops bs ON bs.id = bk.boarding_stop_id JOIN terminals bt ON bt.id = bs.terminal_id
     JOIN route_stops ds ON ds.id = bk.dropping_stop_id JOIN terminals dt ON dt.id = ds.terminal_id
     WHERE bk.id = $1`,
    [id],
    client,
  );
  if (!booking) return null;
  const { rows: tickets } = await query(
    `SELECT tk.id, tk.ticket_no, ls.seat_number, tk.passenger_name, tk.passenger_gender, tk.passenger_age,
            tk.fare_amount, tk.status
     FROM tickets tk JOIN layout_seats ls ON ls.id = tk.seat_id
     WHERE tk.booking_id = $1 ORDER BY ls.seat_number`,
    [id],
    client,
  );
  const { rows: payments } = await query(
    `SELECT id, method, status, amount, currency, paid_at, created_at FROM payments WHERE booking_id = $1 ORDER BY created_at`,
    [id],
    client,
  );
  const { rows: refunds } = await query(
    `SELECT id, amount, cancellation_fee, status, channel, created_at, processed_at FROM refunds WHERE booking_id = $1 ORDER BY created_at`,
    [id],
    client,
  );
  // The full CNIC never leaves the server: staff confirm it by typing it in (see counterCancel).
  const { holderCnic, ...rest } = booking;
  return { ...rest, holderCnicMasked: cnicMasked(holderCnic), tickets, payments, refunds };
}

export function assertCanAccess(booking, user) {
  if (!booking) throw AppError.notFound('Booking not found');
  if (isStaff(user)) return;
  // Return 404 rather than 403 so booking ids cannot be probed.
  if (!user || booking.userId !== user.id) throw AppError.notFound('Booking not found');
}

// ---------------------------------------------------------------------------
// Promo codes
// ---------------------------------------------------------------------------
async function applyPromo(client, { code, routeId, subtotal, userId }) {
  const promo = await one(
    `SELECT * FROM promo_codes
     WHERE upper(code) = upper($1) AND is_active AND now() BETWEEN valid_from AND valid_to
     FOR UPDATE`,
    [code],
    client,
  );
  const invalid = () => AppError.unprocessable('Promo code is invalid or has expired');
  if (!promo) throw invalid();
  if (promo.routeId && promo.routeId !== routeId) throw AppError.unprocessable('Promo code is not valid for this route');
  if (promo.usageLimit !== null && promo.timesUsed >= promo.usageLimit) throw invalid();
  if (subtotal < promo.minBookingAmount) {
    throw AppError.unprocessable(`Promo code requires a minimum booking of ${promo.minBookingAmount}`);
  }
  if (userId) {
    const used = await one(
      `SELECT count(*)::int AS n FROM bookings
       WHERE user_id = $1 AND promo_code_id = $2 AND status IN ('pending','confirmed','completed')`,
      [userId, promo.id],
      client,
    );
    if (used.n >= promo.perUserLimit) throw AppError.unprocessable('You have already used this promo code');
  }

  let discount =
    promo.discountType === 'percentage' ? round2((subtotal * promo.discountValue) / 100) : promo.discountValue;
  if (promo.maxDiscount !== null) discount = Math.min(discount, promo.maxDiscount);
  discount = Math.min(discount, subtotal);
  return { promoId: promo.id, discount: round2(discount) };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createBooking(user, input) {
  const staff = isStaff(user);
  if (input.passengers.length > env.MAX_SEATS_PER_BOOKING) {
    throw AppError.badRequest(`A booking can have at most ${env.MAX_SEATS_PER_BOOKING} seats`);
  }
  // Customers can only book online channels; counter/phone/agent are staff-only.
  const channel = staff ? input.channel ?? 'counter' : input.channel === 'mobile_app' ? 'mobile_app' : 'web';

  return withTransaction(async (client) => {
    await client.query(`SELECT expire_stale_bookings()`);

    if (!staff) {
      const pending = await one(
        `SELECT count(*)::int AS n FROM bookings WHERE user_id = $1 AND status = 'pending'`,
        [user.id],
        client,
      );
      if (pending.n >= MAX_PENDING_PER_USER) {
        throw new AppError(429, 'You have too many unpaid bookings. Pay or cancel them first.', 'TOO_MANY_PENDING');
      }
    }

    // Lock the trip row in share mode so it cannot be cancelled mid-booking.
    const trip = await one(
      `SELECT t.id, t.route_id, t.status, t.booking_open, t.booking_closes_at, t.departure_at, b.bus_class
       FROM trips t JOIN buses b ON b.id = t.bus_id
       WHERE t.id = $1 FOR SHARE OF t`,
      [input.tripId],
      client,
    );
    if (!trip) throw AppError.notFound('Trip not found');

    // Booking holder's CNIC. Customer: their account's CNIC, always; an account without one (made before CNICs
    // were asked for, or by phone code) gets the one typed now, saved for every later booking. Staff: the
    // walk-in customer's CNIC they typed.
    let holderCnic;
    if (staff) {
      if (!input.holderCnic) throw AppError.badRequest("Enter the customer's CNIC.");
      holderCnic = cnicDigits(input.holderCnic);
    } else {
      const acct = await one(`SELECT cnic FROM users WHERE id = $1 FOR UPDATE`, [user.id], client);
      if (acct?.cnic) holderCnic = cnicDigits(acct.cnic);
      else {
        if (!input.holderCnic) throw AppError.badRequest('Enter your CNIC. It is saved to your account for every booking.');
        holderCnic = cnicDigits(input.holderCnic);
        await client.query(`UPDATE users SET cnic = $2 WHERE id = $1`, [user.id, cnicDisplay(holderCnic)]);
      }
    }

    const allowedStatuses = staff ? ['scheduled', 'delayed', 'boarding'] : ['scheduled', 'delayed'];
    if (!allowedStatuses.includes(trip.status) || !trip.bookingOpen) {
      throw AppError.unprocessable('Booking is closed for this trip');
    }
    const now = Date.now();
    if (new Date(trip.departureAt).getTime() <= now) throw AppError.unprocessable('This trip has already departed');
    if (!staff && trip.bookingClosesAt && new Date(trip.bookingClosesAt).getTime() <= now) {
      throw AppError.unprocessable('Online booking has closed for this trip. Please book at the counter.');
    }

    // Price is always computed server-side; the client never sends amounts.
    const fare = await findFare(
      {
        routeId: trip.routeId,
        fromStopId: input.boardingStopId,
        toStopId: input.droppingStopId,
        busClass: trip.busClass,
        departureAt: trip.departureAt,
      },
      client,
    );
    if (!fare) throw AppError.unprocessable('No fare is available for the selected stops');

    const subtotal = round2(fare.amount * input.passengers.length);
    let promoId = null;
    let discount = 0;
    if (input.promoCode) {
      ({ promoId, discount } = await applyPromo(client, {
        code: input.promoCode,
        routeId: trip.routeId,
        subtotal,
        userId: staff ? null : user.id,
      }));
    }

    // Stop order / route membership is enforced by the bookings_validate_stops trigger.
    const booking = await one(
      `INSERT INTO bookings (user_id, trip_id, boarding_stop_id, dropping_stop_id, contact_name, contact_phone,
                             contact_email, channel, booked_by_agent_id, promo_code_id, subtotal, discount_amount,
                             currency, hold_expires_at, notes, holder_cnic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now() + make_interval(mins => $14), $15, $16)
       RETURNING id`,
      [
        staff ? input.customerId ?? null : user.id,
        trip.id,
        input.boardingStopId,
        input.droppingStopId,
        input.contact.name,
        input.contact.phone,
        input.contact.email ?? null,
        channel,
        staff ? user.id : null,
        promoId,
        subtotal,
        discount,
        fare.currency,
        env.BOOKING_HOLD_MINUTES,
        staff ? input.notes ?? null : null,
        holderCnic,
      ],
      client,
    );

    // Seat ownership and bookability are enforced by the tickets_validate_seat trigger, the side-by-side
    // gender rule by tickets_validate_seat_neighbours, and double booking by tickets_trip_seat_active_uq.
    for (const p of input.passengers) {
      await client.query(
        `INSERT INTO tickets (booking_id, trip_id, seat_id, passenger_name, passenger_gender, passenger_age,
                              passenger_cnic, passenger_phone, fare_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'held')`,
        [booking.id, trip.id, p.seatId, p.name, p.gender, p.age ?? null, p.cnic ?? null, p.phone ?? null, fare.amount],
      );
    }

    return getBookingDetail(booking.id, client);
  });
}

// ---------------------------------------------------------------------------
// Confirm (called after a successful payment, inside the payment transaction)
// ---------------------------------------------------------------------------
/**
 * An expired booking's tickets were cancelled when its hold ended. Put them back on hold so the booking can be
 * confirmed, but only while the trip has not left and every seat is still free (the active-seat unique index
 * decides that). Returns false, with nothing changed, if any seat was taken meanwhile.
 */
async function reclaimExpiredSeats(client, bookingId) {
  const trip = await one(
    `SELECT t.status, t.departure_at > now() AS upcoming FROM bookings bk JOIN trips t ON t.id = bk.trip_id WHERE bk.id = $1`,
    [bookingId],
    client,
  );
  if (!trip?.upcoming || !['scheduled', 'delayed', 'boarding'].includes(trip.status)) return false;
  await client.query('SAVEPOINT reclaim_seats');
  try {
    await client.query(`UPDATE tickets SET status = 'held' WHERE booking_id = $1 AND status = 'cancelled'`, [bookingId]);
    await client.query('RELEASE SAVEPOINT reclaim_seats');
    return true;
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT reclaim_seats');
    // A seat now belongs to another booking, or a passenger of the other gender now sits beside it.
    if (err.code === '23505' || err.code === 'NKG01') return false;
    throw err;
  }
}

export async function confirmBookingInTx(client, bookingId) {
  const bk = await one(`SELECT id, status, promo_code_id, user_id, contact_phone FROM bookings WHERE id = $1 FOR UPDATE`, [bookingId], client);
  if (!bk) throw AppError.notFound('Booking not found');
  if (bk.status === 'confirmed') return { confirmed: true, alreadyConfirmed: true };
  if (bk.status === 'expired') {
    // Paid after the hold ran out (Safepay told us late). Re-take the same seats if nobody else has them.
    if (!(await reclaimExpiredSeats(client, bookingId))) return { confirmed: false, status: bk.status };
  } else if (bk.status !== 'pending') {
    return { confirmed: false, status: bk.status };
  }

  // The seats are held by this booking: still pending, or just reclaimed above.
  await client.query(`UPDATE bookings SET status = 'confirmed' WHERE id = $1`, [bookingId]);
  if (bk.promoCodeId) {
    await client.query(`UPDATE promo_codes SET times_used = times_used + 1 WHERE id = $1`, [bk.promoCodeId]);
  }
  await client.query(
    `INSERT INTO notifications (user_id, booking_id, channel, recipient, template, payload)
     VALUES ($1, $2, 'sms', $3, 'booking_confirmed', '{}'::jsonb)`,
    [bk.userId, bookingId, bk.contactPhone],
  );
  return { confirmed: true };
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
async function refundQuote(client, booking) {
  const paid = await one(
    `SELECT COALESCE(sum(amount), 0) AS total, (array_agg(id ORDER BY amount DESC))[1] AS payment_id,
            (array_agg(method ORDER BY amount DESC))[1] AS method
     FROM payments WHERE booking_id = $1 AND status = 'succeeded'`,
    [booking.id],
    client,
  );
  const hoursBefore = (new Date(booking.departureAt).getTime() - Date.now()) / 3_600_000;
  if (hoursBefore <= 0) {
    return { paid: paid.total, refundPercent: 0, refundAmount: 0, fee: paid.total, paymentId: paid.paymentId, method: paid.method, hoursBefore };
  }

  const policy = await one(
    `SELECT refund_percent FROM cancellation_policies
     WHERE is_active AND min_hours_before <= $1 ORDER BY min_hours_before DESC LIMIT 1`,
    [Math.floor(hoursBefore)],
    client,
  );
  const pct = policy?.refundPercent ?? 0;
  const refundAmount = round2((paid.total * pct) / 100);
  return {
    paid: paid.total,
    refundPercent: pct,
    refundAmount,
    fee: round2(paid.total - refundAmount),
    paymentId: paid.paymentId,
    method: paid.method,
    hoursBefore: Math.floor(hoursBefore),
  };
}

async function lockBookingWithTrip(client, id) {
  return one(
    `SELECT bk.id, bk.pnr, bk.user_id, bk.status, bk.holder_cnic, bk.contact_phone, t.departure_at, t.status AS trip_status
     FROM bookings bk JOIN trips t ON t.id = bk.trip_id
     WHERE bk.id = $1 FOR UPDATE OF bk`,
    [id],
    client,
  );
}

export async function getCancellationQuote(id, user) {
  return withTransaction(async (client) => {
    const bk = await lockBookingWithTrip(client, id);
    assertCanAccess(bk, user);
    if (!['pending', 'confirmed'].includes(bk.status)) throw AppError.unprocessable(`Booking is ${bk.status}`);
    const q = await refundQuote(client, bk);
    return { refundPercent: q.refundPercent, paid: q.paid, refundAmount: q.refundAmount, cancellationFee: q.fee, hoursBeforeDeparture: q.hoursBefore };
  });
}

export async function cancelBooking(id, user, reason) {
  return withTransaction(async (client) => {
    const bk = await lockBookingWithTrip(client, id);
    assertCanAccess(bk, user);
    if (!['pending', 'confirmed'].includes(bk.status)) throw AppError.unprocessable(`Booking is already ${bk.status}`);
    if (!['scheduled', 'delayed'].includes(bk.tripStatus) && !isStaff(user)) {
      throw AppError.unprocessable('This booking can no longer be cancelled online');
    }

    let refund = null;
    if (bk.status === 'confirmed') {
      const q = await refundQuote(client, bk);
      if (q.refundAmount > 0 && q.paymentId) {
        refund = await one(
          `INSERT INTO refunds (payment_id, booking_id, amount, cancellation_fee, status, reason)
           VALUES ($1, $2, $3, $4, 'requested', $5) RETURNING id, amount, cancellation_fee, status`,
          [q.paymentId, bk.id, q.refundAmount, q.fee, reason ?? 'Cancelled by customer'],
          client,
        );
      }
    }

    // Trigger bookings_status_change releases all seats.
    await client.query(`UPDATE bookings SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [
      bk.id,
      reason ?? null,
    ]);
    return { booking: await getBookingDetail(bk.id, client), refund };
  });
}

/** After a refund is paid out: the payment becomes refunded, or partially refunded while money is still kept. */
export async function markPaymentRefunded(client, paymentId) {
  await client.query(
    `UPDATE payments p SET status = CASE
        WHEN (SELECT COALESCE(sum(amount), 0) FROM refunds WHERE payment_id = p.id AND status = 'processed') >= p.amount
        THEN 'refunded'::payment_status ELSE 'partially_refunded'::payment_status END
     WHERE p.id = $1`,
    [paymentId],
  );
}

// ---------------------------------------------------------------------------
// Counter cancellation: staff cancel a paid booking for a customer standing at any New Khan counter.
//  - The refund is worked out by the cancellation rules, never typed in.
//  - Paid in cash: the refund is paid out in cash there and then (recorded as processed by that staff member).
//  - Paid online: the booking is cancelled, and the refund waits for a super admin to approve it online.
//  - Before anything happens the holder is confirmed: the CNIC typed in must match the booking's, or (older
//    bookings without a CNIC) the code sent by SMS to the booking's phone number must be entered.
// ---------------------------------------------------------------------------
const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const codeHash = (bookingId, code) => createHash('sha256').update(`${bookingId}:${code}`).digest('hex');
const maskPhone = (p) => (p ? `${p.slice(0, 4)}•••••${p.slice(-3)}` : null);
const refundHow = (q) => (!q || q.refundAmount <= 0 || !q.paymentId ? 'none' : q.method === 'cash' ? 'cash_now' : 'online_approval');

function assertCounterCancellable(bk) {
  if (!bk) throw AppError.notFound('Booking not found');
  if (bk.status !== 'confirmed') throw AppError.unprocessable(`Only a paid booking is cancelled and refunded here. This one is ${bk.status}.`);
  if (!['scheduled', 'delayed', 'boarding'].includes(bk.tripStatus)) {
    throw AppError.unprocessable(`The trip is ${bk.tripStatus}, so this booking can no longer be cancelled.`);
  }
}

/** What the counter screen shows before cancelling: the refund, how it is paid, and how to confirm the holder. */
export async function getCounterQuote(id) {
  return withTransaction(async (client) => {
    const bk = await lockBookingWithTrip(client, id);
    assertCounterCancellable(bk);
    const q = await refundQuote(client, bk);
    return {
      pnr: bk.pnr,
      paid: q.paid,
      paidBy: q.method,
      refundPercent: q.refundPercent,
      refundAmount: q.refundAmount,
      cancellationFee: q.fee,
      hoursBeforeDeparture: q.hoursBefore,
      refundHow: refundHow(q),
      identityCheck: bk.holderCnic ? 'cnic' : 'sms_code',
      holderCnicMasked: cnicMasked(bk.holderCnic),
      phoneMasked: maskPhone(bk.contactPhone),
    };
  });
}

/** Sends a one-time code to the booking's phone, for bookings that have no CNIC on file. */
export async function sendCounterCode(id, staff) {
  const bk = await one(`SELECT id, pnr, status, holder_cnic, contact_phone FROM bookings WHERE id = $1`, [id]);
  if (!bk) throw AppError.notFound('Booking not found');
  if (bk.status !== 'confirmed') throw AppError.unprocessable(`This booking is ${bk.status}.`);
  if (bk.holderCnic) throw AppError.unprocessable('This booking has a CNIC on file. Check the CNIC instead.');
  const recent = await one(
    `SELECT count(*)::int AS n FROM refund_codes WHERE booking_id = $1 AND created_at > now() - interval '1 hour'`,
    [bk.id],
  );
  if (recent.n >= CODES_PER_HOUR) throw new AppError(429, 'Too many codes sent for this booking. Try again later.', 'TOO_MANY_CODES');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const sms = await sendSms(
    bk.contactPhone,
    `New Khan: code ${code} lets the counter cancel booking ${bk.pnr} and refund it. Valid ${CODE_TTL_MINUTES} minutes. Only share it at a New Khan counter.`,
  );
  await withTransaction(async (client) => {
    await client.query(`UPDATE refund_codes SET used_at = now() WHERE booking_id = $1 AND used_at IS NULL`, [bk.id]);
    await client.query(
      `INSERT INTO refund_codes (booking_id, code_hash, sent_to, requested_by, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))`,
      [bk.id, codeHash(bk.id, code), bk.contactPhone, staff.id, CODE_TTL_MINUTES],
    );
  });
  // No SMS provider yet (development only): hand the code back so the flow can be tested.
  return { sentTo: maskPhone(bk.contactPhone), expiresInMinutes: CODE_TTL_MINUTES, ...(sms.sent ? {} : { devCode: code }) };
}

/** Checks the SMS code. Wrong tries are counted outside the cancel transaction so a failure cannot undo them. */
async function verifyCounterCode(bookingId, code) {
  const rc = await one(
    `UPDATE refund_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM refund_codes WHERE booking_id = $1 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)
     RETURNING id, code_hash, attempts, expires_at > now() AS live`,
    [bookingId],
  );
  if (!rc || !rc.live || rc.attempts > CODE_MAX_ATTEMPTS) {
    throw new AppError(422, 'The code has expired or was tried too many times. Send a new code.', 'CODE_EXPIRED');
  }
  if (codeHash(bookingId, String(code).trim()) !== rc.codeHash) {
    throw new AppError(422, 'The code is not correct. Do not cancel or refund.', 'IDENTITY_MISMATCH');
  }
  return rc.id;
}

export async function counterCancel(id, staff, { cnic, code, reason }) {
  // Confirm the holder first.
  const pre = await one(`SELECT id, holder_cnic FROM bookings WHERE id = $1`, [id]);
  if (!pre) throw AppError.notFound('Booking not found');
  let identityCheck;
  let codeId = null;
  if (pre.holderCnic) {
    if (!cnic) throw AppError.badRequest("Enter the customer's CNIC.");
    if (cnicDigits(cnic) !== pre.holderCnic) {
      throw new AppError(422, 'This CNIC does not match the booking holder. Do not cancel or refund.', 'IDENTITY_MISMATCH');
    }
    identityCheck = 'cnic';
  } else {
    if (!code) throw AppError.badRequest("Enter the code sent to the booking's phone number.");
    codeId = await verifyCounterCode(pre.id, code);
    identityCheck = 'sms_code';
  }

  const note = reason ?? 'Cancelled at the counter';
  return withTransaction(async (client) => {
    const bk = await lockBookingWithTrip(client, id);
    assertCounterCancellable(bk);
    const q = await refundQuote(client, bk);
    const how = refundHow(q);

    let refund = null;
    if (how !== 'none') {
      const cash = how === 'cash_now';
      refund = await one(
        `INSERT INTO refunds (payment_id, booking_id, amount, cancellation_fee, status, reason, channel, identity_check,
                              processed_by, processed_at)
         VALUES ($1, $2, $3, $4, $5::refund_status, $6, $7, $8, $9, CASE WHEN $5::refund_status = 'processed' THEN now() END)
         RETURNING id, amount, cancellation_fee, status, channel`,
        [q.paymentId, bk.id, q.refundAmount, q.fee, cash ? 'processed' : 'requested', note, cash ? 'counter' : 'online',
          identityCheck, cash ? staff.id : null],
        client,
      );
      if (cash) await markPaymentRefunded(client, q.paymentId);
    }
    if (codeId) await client.query(`UPDATE refund_codes SET used_at = now() WHERE id = $1`, [codeId]);

    // Trigger bookings_status_change releases all seats.
    await client.query(`UPDATE bookings SET status = 'cancelled', cancel_reason = $2 WHERE id = $1`, [bk.id, note]);
    return { booking: await getBookingDetail(bk.id, client), refund, refundHow: how, identityCheck };
  });
}
