import { env } from '../config/env.js';
import { logger } from './logger.js';
import { AppError } from './AppError.js';

/**
 * Sends one SMS. NO SMS PROVIDER IS CONNECTED YET: New Khan has to choose one (or a WhatsApp Business account)
 * and its sending call goes in `deliver` below.
 *
 * Until then:
 *   - in development and test, nothing is sent; the message is logged and `{ sent: false, preview }` is returned,
 *     so the caller can show a one-time code on screen for testing;
 *   - in production it refuses, so a code is never silently "sent" to nobody.
 */
const deliver = null; // async (to, text) => { ...call the provider... }

export async function sendSms(to, text) {
  if (deliver) {
    await deliver(to, text);
    return { sent: true };
  }
  if (env.isProd) {
    throw new AppError(503, 'SMS sending is not set up yet, so a code cannot be sent. Ask for the CNIC instead.', 'SMS_UNAVAILABLE');
  }
  logger.warn({ to: `${to.slice(0, 4)}…${to.slice(-3)}` }, 'SMS not sent: no SMS provider configured (development)');
  return { sent: false, preview: text };
}
