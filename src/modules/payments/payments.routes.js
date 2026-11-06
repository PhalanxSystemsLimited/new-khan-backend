import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, STAFF_ROLES } from '../../middleware/auth.js';
import { paymentLimiter } from '../../middleware/rateLimit.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { logger } from '../../utils/logger.js';
import { money, uuid } from '../../utils/schemas.js';
import { assertCanAccess, confirmBookingInTx, getBookingDetail } from '../bookings/bookings.service.js';
import { gatewayFor, gateways, ONLINE_METHODS } from './gateways.js';
import { PAID_STATE, fetchTracker, frontendUrl, isValidTracker, safepayEnabled } from './safepay.js';

const router = Router();

const idempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Idempotency-Key header must be 16-64 URL-safe characters');
const lang = z.enum(['en', 'ur']);

async function lockPayableBooking(client, bookingId, user) {
  const bk = await one(
    `SELECT id, user_id, status, total_amount, currency, hold_expires_at FROM bookings WHERE id = $1 FOR UPDATE`,
    [bookingId],
    client,
  );
  assertCanAccess(bk, user);
  if (bk.status !== 'pending') throw AppError.unprocessable(`Booking is ${bk.status} and cannot be paid`);
  if (bk.holdExpiresAt && new Date(bk.holdExpiresAt).getTime() <= Date.now()) {
    throw AppError.unprocessable('Seat hold has expired. Please make a new booking.');
  }
  return bk;
}

/**
 * Start an online payment. The amount always comes from the booking in the DB.
 * Requires an Idempotency-Key header so retries never create duplicate charges.
 */
router.post(
  '/intent',
  requireAuth,
  paymentLimiter,
  validate({ body: z.object({ bookingId: uuid, method: z.enum(ONLINE_METHODS), lang: lang.optional() }).strict() }),
  async (req, res) => {
    const keyCheck = idempotencyKey.safeParse(req.get('idempotency-key'));
    if (!keyCheck.success) throw AppError.badRequest(keyCheck.error.issues[0].message);
    // Scope the key per user and hash it to a fixed 64-char value.
    const key = crypto.createHash('sha256').update(`${req.user.id}:${keyCheck.data}`).digest('hex');
    const { bookingId, method, lang: uiLang = 'en' } = req.valid.body;

    const { payment, replay } = await withTransaction(async (client) => {
      const existing = await one(`SELECT * FROM payments WHERE idempotency_key = $1`, [key], client);
      if (existing) {
        if (existing.bookingId !== bookingId) throw AppError.conflict('Idempotency-Key already used for another booking');
        // Only hand out the checkout again while the booking can still be paid.
        if (existing.status === 'pending') await lockPayableBooking(client, bookingId, req.user);
        return { payment: existing, replay: true };
      }
      const bk = await lockPayableBooking(client, bookingId, req.user);
      const p = await one(
        `INSERT INTO payments (booking_id, method, status, amount, currency, gateway, idempotency_key)
         VALUES ($1, $2, 'pending', $3, $4, $5, $6) RETURNING *`,
        [bk.id, method, bk.totalAmount, bk.currency, gatewayFor(method), key],
        client,
      );
      return { payment: p, replay: false };
    });

    const gw = gateways[payment.gateway];
    if (!gw) throw AppError.unprocessable('This payment can no longer be continued. Please start a new payment.');
    const checkout = payment.status === 'pending' ? await gw.createCheckout(payment, { lang: uiLang }) : null;
    res.status(replay ? 200 : 201).json({
      data: { paymentId: payment.id, status: payment.status, amount: payment.amount, currency: payment.currency, checkout },
    });
  },
);

/** Counter staff record a cash payment; this confirms the booking immediately. */
router.post(
  '/cash',
  requireAuth,
  requireRole(...STAFF_ROLES),
  validate({ body: z.object({ bookingId: uuid, amount: money }).strict() }),
  async (req, res) => {
    const { bookingId, amount } = req.valid.body;
    const result = await withTransaction(async (client) => {
      const bk = await lockPayableBooking(client, bookingId, req.user);
      if (Math.abs(amount - bk.totalAmount) > 0.001) {
        throw AppError.unprocessable(`Amount must equal the booking total (${bk.totalAmount})`);
      }
      const p = await one(
        `INSERT INTO payments (booking_id, method, status, amount, currency, received_by, paid_at)
         VALUES ($1, 'cash', 'succeeded', $2, $3, $4, now()) RETURNING id`,
        [bk.id, bk.totalAmount, bk.currency, req.user.id],
        client,
      );
      await confirmBookingInTx(client, bk.id);
      await audit({ req, client, action: 'payment.cash', entityType: 'payment', entityId: p.id, newData: { bookingId, amount } });
      return getBookingDetail(bk.id, client);
    });
    res.status(201).json({ data: result });
  },
);

// ---------------- Settling a gateway result ----------------
/**
 * Apply a verified gateway result to a payment row locked FOR UPDATE.
 * Idempotent: a payment that is already settled is reported as 'duplicate' with no side effects.
 * `amount` is checked when given; omit it when the gateway session itself is bound to the amount.
 */
async function settlePayment(client, p, { status, amount, currency, gatewayTxnId, raw }) {
  if (['succeeded', 'failed', 'refunded', 'partially_refunded'].includes(p.status)) return 'duplicate';

  const response = JSON.stringify(raw ?? {});
  const markFailed = () =>
    client.query(`UPDATE payments SET status = 'failed', gateway_txn_id = $2, gateway_response = $3::jsonb WHERE id = $1`, [
      p.id,
      gatewayTxnId,
      response,
    ]);

  if (status === 'failed') {
    await markFailed();
    return 'failed';
  }

  if ((amount != null && Math.abs(amount - p.amount) > 0.001) || (currency && currency !== p.currency)) {
    logger.error({ paymentId: p.id, expected: p.amount, got: amount }, 'Gateway amount mismatch');
    await markFailed();
    return 'amount_mismatch';
  }

  await client.query(
    `UPDATE payments SET status = 'succeeded', gateway_txn_id = $2, gateway_response = $3::jsonb, paid_at = now()
     WHERE id = $1`,
    [p.id, gatewayTxnId, response],
  );
  const c = await confirmBookingInTx(client, p.bookingId);
  if (!c.confirmed || c.alreadyConfirmed) {
    // Cancelled, expired with its seats since taken, or already paid by another payment: refund this one in full.
    const reason = c.alreadyConfirmed ? 'Duplicate payment: booking was already paid' : `Payment received after booking was ${c.status}`;
    await client.query(
      `INSERT INTO refunds (payment_id, booking_id, amount, status, reason)
       VALUES ($1, $2, $3, 'approved', $4)`,
      [p.id, p.bookingId, p.amount, reason],
    );
    return 'refund_required';
  }
  return 'confirmed';
}

// ---------------- Gateway webhook ----------------
/**
 * Mounted with express.raw() in app.js so the signature is computed over the exact bytes received.
 * Always idempotent: repeated deliveries of the same event are acknowledged without side effects.
 */
export async function paymentWebhook(req, res) {
  const gateway = req.params.gateway;
  const gw = gateways[gateway];
  if (!gw) throw AppError.notFound('Unknown gateway');

  const result = gw.parseWebhook(req);
  if (!result.valid) {
    logger.warn({ gateway, ip: req.ip }, 'Rejected webhook with invalid signature');
    throw AppError.unauthorized('Invalid signature');
  }
  if (result.ignore) {
    logger.info({ gateway, reason: result.ignore }, 'Webhook acknowledged without action');
    return res.json({ received: true, outcome: 'ignored' });
  }

  const ev = result.event;
  const outcome = await withTransaction(async (client) => {
    const p = ev.paymentId
      ? await one(`SELECT * FROM payments WHERE id = $1 AND gateway = $2 FOR UPDATE`, [ev.paymentId, gateway], client)
      : await one(`SELECT * FROM payments WHERE gateway = $1 AND gateway_txn_id = $2 FOR UPDATE`, [gateway, ev.txnId], client);
    if (!p) throw AppError.notFound('Payment not found');
    return settlePayment(client, p, ev);
  });

  logger.info({ gateway, outcome }, 'Webhook processed');
  res.json({ received: true, outcome });
}

// ---------------- Safepay: settle from Safepay's own record ----------------
/**
 * Asks Safepay about one tracker this server created and, if it is paid (TRACKER_ENDED), settles the payment
 * with the amount Safepay reports. Returns the settle outcome, 'unpaid', or 'not_found'.
 */
async function settleSafepayTracker(tracker, source) {
  const status = await fetchTracker(tracker);
  if (status.state !== PAID_STATE) return { outcome: 'unpaid', state: status.state };
  return withTransaction(async (client) => {
    const p = await one(`SELECT * FROM payments WHERE gateway = 'safepay' AND gateway_txn_id = $1 FOR UPDATE`, [tracker], client);
    if (!p) return { outcome: 'not_found' };
    const outcome = await settlePayment(client, p, {
      status: 'succeeded',
      amount: status.amount ?? undefined,
      currency: status.currency ?? undefined,
      gatewayTxnId: tracker,
      raw: { source, tracker, state: status.state },
    });
    return { outcome, bookingId: p.bookingId };
  });
}

/**
 * Settles any Safepay payment of a booking that Safepay says is paid but this server has not recorded yet
 * (the customer never came back from the checkout page, or the webhook could not reach this server).
 * Called when a booking is opened and by the expiry job before releasing seats. Never throws.
 */
export async function reconcileSafepayBooking(bookingId) {
  if (!safepayEnabled) return;
  try {
    const { rows } = await query(
      `SELECT gateway_txn_id FROM payments
       WHERE booking_id = $1 AND gateway = 'safepay' AND status IN ('initiated', 'pending') AND gateway_txn_id LIKE 'track%'`,
      [bookingId],
    );
    for (const r of rows) {
      const { outcome } = await settleSafepayTracker(r.gatewayTxnId, 'reconcile');
      if (outcome !== 'unpaid') logger.info({ outcome }, 'Safepay payment reconciled');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Safepay reconcile failed');
  }
}

// ---------------- Safepay return (customer's browser) ----------------
/** Safepay may append "?tracker=" to a URL that already has a query; recover the tracker from anywhere in the URL. */
function trackerFrom(req, src) {
  if (typeof src.tracker === 'string' && isValidTracker(src.tracker)) return src.tracker;
  const m = /[?&]tracker=(track_[A-Za-z0-9_-]{1,110})/.exec(decodeURIComponent(req.originalUrl));
  return m ? m[1] : '';
}

/**
 * Safepay sends the customer here after checkout (/api/v1/payments/safepay/return/:lang?tracker=track_...,
 * as a GET or a form POST). Nothing in the URL is trusted: the server asks Safepay for the tracker and
 * confirms the booking only if it is paid (TRACKER_ENDED) for exactly the booking amount.
 * Mounted in app.js before CORS, since the navigation comes from Safepay's site.
 */
export async function safepayReturn(req, res) {
  const src = { ...req.query, ...(req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {}) };
  const langIn = req.params.lang ?? String(src.lang ?? '').slice(0, 2);
  const uiLang = lang.safeParse(langIn).success ? langIn : 'en';
  const tracker = trackerFrom(req, src);

  if (!safepayEnabled || !tracker) {
    logger.warn({ ip: req.ip }, 'Safepay return without a valid tracker');
    return res.redirect(303, frontendUrl(uiLang, 'my-bookings', {}));
  }

  // Only trackers this server created are looked at.
  const known = await one(`SELECT booking_id FROM payments WHERE gateway = 'safepay' AND gateway_txn_id = $1`, [tracker]);
  if (!known) {
    logger.warn({ ip: req.ip }, 'Safepay return for an unknown tracker');
    return res.redirect(303, frontendUrl(uiLang, 'my-bookings', {}));
  }

  const { outcome, bookingId = known.bookingId } = await settleSafepayTracker(tracker, 'redirect');
  logger.info({ outcome }, 'Safepay return processed');
  if (outcome === 'unpaid') return res.redirect(303, frontendUrl(uiLang, 'reserved', { ref: bookingId, payment: 'failed' }));
  if (outcome === 'amount_mismatch' || outcome === 'refund_required') {
    return res.redirect(303, frontendUrl(uiLang, 'reserved', { ref: bookingId, payment: 'review' }));
  }
  return res.redirect(303, frontendUrl(uiLang, 'confirmed', { ref: bookingId, paid: '1' }));
}

export default router;
