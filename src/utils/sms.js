import { env } from '../config/env.js';
import { query } from '../config/db.js';
import { logger } from './logger.js';
import { AppError } from './AppError.js';

/**
 * Sends one SMS through New Khan's bulk-SMS provider (Jazz, Zong, Telenor or an aggregator).
 *
 * SMS IS OFF until SMS_API_URL is set (see .env.example and README "SMS"). While it is off:
 *   - booking confirmations are simply not sent, and online booking skips the phone-code step;
 *   - in development a code-based screen gets the code back on screen (`{ sent: false, preview }`), for testing;
 *   - in production a request that needs a code is refused, so a code is never silently "sent" to nobody.
 *
 * Every message tried is written to sms_messages (number partly hidden, no codes).
 */
export const smsEnabled = () => Boolean(env.SMS_API_URL);

/** +923001234567 -> the provider's format. */
function formatPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  const intl = d.startsWith('92') ? d : d.startsWith('0') ? `92${d.slice(1)}` : d;
  if (env.SMS_PHONE_FORMAT === 'local') return `0${intl.slice(2)}`;
  if (env.SMS_PHONE_FORMAT === 'plus') return `+${intl}`;
  return intl;
}

const maskTo = (p) => (p ? `${String(p).slice(0, 4)}…${String(p).slice(-3)}` : null);

async function deliver(to, text) {
  const fill = (s) =>
    s
      .replaceAll('{to}', encodeURIComponent(formatPhone(to)))
      .replaceAll('{text}', encodeURIComponent(text))
      .replaceAll('{sender}', encodeURIComponent(env.SMS_SENDER))
      .replaceAll('{username}', encodeURIComponent(env.SMS_USERNAME))
      .replaceAll('{password}', encodeURIComponent(env.SMS_PASSWORD));
  const url = fill(env.SMS_API_URL);
  let res;
  if (env.SMS_METHOD === 'POST') {
    const [base, qs = ''] = url.split('?');
    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: qs,
      signal: AbortSignal.timeout(10_000),
    });
  } else {
    res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  }
  const body = (await res.text()).slice(0, 500);
  if (!res.ok) throw new Error(`SMS provider answered ${res.status}`);
  if (env.SMS_SUCCESS_TEXT && !body.toLowerCase().includes(env.SMS_SUCCESS_TEXT.toLowerCase())) {
    throw new Error('SMS provider did not confirm the message');
  }
}

/**
 * kind: 'booking_confirmed' | 'phone_code' | 'refund_code' (for the log).
 * Throws AppError 503 when SMS is on but the provider fails, or when it is off in production.
 */
export async function sendSms(to, text, { kind = 'other', bookingId = null } = {}) {
  if (!smsEnabled()) {
    if (env.isProd) {
      throw new AppError(503, 'SMS sending is not set up yet, so a code cannot be sent.', 'SMS_UNAVAILABLE');
    }
    logger.warn({ to: maskTo(to), kind }, 'SMS not sent: SMS is off (development)');
    return { sent: false, preview: text };
  }
  try {
    await deliver(to, text);
    await logSms(to, kind, bookingId, 'sent', null);
    return { sent: true };
  } catch (err) {
    logger.error({ to: maskTo(to), kind, err: err.message }, 'SMS failed');
    await logSms(to, kind, bookingId, 'failed', err.message);
    throw new AppError(503, 'The SMS could not be sent. Please try again in a minute.', 'SMS_FAILED');
  }
}

async function logSms(to, kind, bookingId, status, error) {
  await query(
    `INSERT INTO sms_messages (to_masked, kind, booking_id, status, error) VALUES ($1, $2, $3, $4, $5)`,
    [maskTo(to), kind, bookingId, status, error ? String(error).slice(0, 300) : null],
  ).catch((e) => logger.warn({ err: e.message }, 'SMS log write failed'));
}
