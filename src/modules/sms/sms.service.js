/**
 * SMS features (all off until SMS is set up, see utils/sms.js):
 *   - phone verification: a 6-digit code to the customer's mobile before an online booking (asked once per number)
 *   - booking confirmation: one SMS after an online booking is paid (ticket number, route, date, seats)
 * Counter and roadside bookings never send SMS.
 */
import { createHash, randomInt } from 'node:crypto';
import { one, query, withTransaction } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';
import { sendSms, smsEnabled } from '../../utils/sms.js';

const CODE_TTL_MINUTES = 10;
const CODE_MAX_ATTEMPTS = 5;
const CODES_PER_HOUR = 5;
const hashOf = (userId, phone, code) => createHash('sha256').update(`${userId}:${phone}:${code}`).digest('hex');

export async function isPhoneVerified(userId, phone) {
  return Boolean(await one(`SELECT 1 FROM verified_phones WHERE user_id = $1 AND phone = $2`, [userId, phone]));
}

/** Sends a code to `phone` for this user. Returns { sentTo, expiresInMinutes } (+ devCode while SMS is off in development). */
export async function sendPhoneCode(user, phone) {
  if (await isPhoneVerified(user.id, phone)) return { alreadyVerified: true };
  const recent = await one(
    `SELECT count(*)::int AS n FROM phone_codes WHERE user_id = $1 AND created_at > now() - interval '1 hour'`,
    [user.id],
  );
  if (recent.n >= CODES_PER_HOUR) throw new AppError(429, 'Too many codes were sent. Please try again in an hour.', 'TOO_MANY_CODES');

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const sms = await sendSms(phone, `New Khan: your verification code is ${code}. It is valid for ${CODE_TTL_MINUTES} minutes. Do not share it.`, {
    kind: 'phone_code',
  });
  await withTransaction(async (client) => {
    await client.query(`UPDATE phone_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id]);
    await client.query(
      `INSERT INTO phone_codes (user_id, phone, code_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
      [user.id, phone, hashOf(user.id, phone, code), CODE_TTL_MINUTES],
    );
  });
  return { sentTo: `${phone.slice(0, 4)}•••••${phone.slice(-3)}`, expiresInMinutes: CODE_TTL_MINUTES, ...(sms.sent ? {} : { devCode: code }) };
}

export async function verifyPhoneCode(user, phone, code) {
  // Count the try first, outside any transaction that a wrong code could roll back.
  const pc = await one(
    `UPDATE phone_codes SET attempts = attempts + 1
     WHERE id = (SELECT id FROM phone_codes WHERE user_id = $1 AND phone = $2 AND used_at IS NULL ORDER BY created_at DESC LIMIT 1)
     RETURNING id, code_hash, attempts, expires_at > now() AS live`,
    [user.id, phone],
  );
  if (!pc || !pc.live || pc.attempts > CODE_MAX_ATTEMPTS) {
    throw new AppError(422, 'The code has expired or was tried too many times. Ask for a new code.', 'CODE_EXPIRED');
  }
  if (hashOf(user.id, phone, String(code).trim()) !== pc.codeHash) {
    throw new AppError(422, 'The code is not correct. Please check the SMS and try again.', 'CODE_WRONG');
  }
  await withTransaction(async (client) => {
    await client.query(`UPDATE phone_codes SET used_at = now() WHERE id = $1`, [pc.id]);
    await client.query(
      `INSERT INTO verified_phones (user_id, phone) VALUES ($1, $2) ON CONFLICT (user_id, phone) DO UPDATE SET verified_at = now()`,
      [user.id, phone],
    );
  });
  return { verified: true };
}

const fmtPk = (iso, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', ...opts }).format(new Date(iso));

/**
 * One confirmation SMS for a paid ONLINE booking. Never throws: a failed SMS must not affect the payment.
 * Call it after the payment's transaction has committed.
 */
export async function sendBookingConfirmationSms(bookingId) {
  if (!smsEnabled() || !bookingId) return;
  try {
    const bk = await one(
      `SELECT bk.id, bk.pnr, bk.contact_phone, bk.channel::text AS channel, bk.status,
              t.departure_at + make_interval(mins => bs.minutes_from_origin) AS departure_at, -- at the boarding stop
              cf.name AS from_city, ct.name AS to_city,
              (SELECT string_agg(ls.seat_number, ', ' ORDER BY ls.seat_number) FROM tickets tk
                 JOIN layout_seats ls ON ls.id = tk.seat_id WHERE tk.booking_id = bk.id AND tk.status = 'confirmed') AS seats,
              EXISTS (SELECT 1 FROM sms_messages m WHERE m.booking_id = bk.id AND m.kind = 'booking_confirmed' AND m.status = 'sent') AS sent_before
       FROM bookings bk JOIN trips t ON t.id = bk.trip_id
       JOIN route_stops bs ON bs.id = bk.boarding_stop_id JOIN terminals tf ON tf.id = bs.terminal_id JOIN cities cf ON cf.id = tf.city_id
       JOIN route_stops ds ON ds.id = bk.dropping_stop_id JOIN terminals tt ON tt.id = ds.terminal_id JOIN cities ct ON ct.id = tt.city_id
       WHERE bk.id = $1`,
      [bookingId],
    );
    if (!bk || bk.status !== 'confirmed' || bk.sentBefore || !['web', 'mobile_app'].includes(bk.channel) || !bk.contactPhone) return;
    const when = `${fmtPk(bk.departureAt, { day: 'numeric', month: 'short' })} ${fmtPk(bk.departureAt, { hour: 'numeric', minute: '2-digit', hour12: true })}`;
    const text =
      `New Khan: booking confirmed. Ticket ${bk.pnr}, ${bk.fromCity} to ${bk.toCity}, ${when}` +
      `${bk.seats ? `, seat ${bk.seats}` : ''}. Show the ticket number and your CNIC at the counter.`;
    await sendSms(bk.contactPhone, text, { kind: 'booking_confirmed', bookingId: bk.id });
  } catch (err) {
    logger.warn({ err: err.message }, 'Booking confirmation SMS not sent');
  }
}

/** For the admin panel: is SMS on, and how many were sent / failed in the last 24 hours. */
export async function smsStatus() {
  const { rows } = await query(
    `SELECT status, count(*)::int AS n FROM sms_messages WHERE created_at > now() - interval '24 hours' GROUP BY status`,
  ).catch(() => ({ rows: [] }));
  const n = (s) => rows.find((r) => r.status === s)?.n ?? 0;
  return { enabled: smsEnabled(), last24h: { sent: n('sent'), failed: n('failed') } };
}
