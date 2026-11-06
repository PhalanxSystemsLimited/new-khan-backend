import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { money, uuid } from '../../utils/schemas.js';
import { safepay, safepayEnabled } from './safepay.js';

/*
 * Payment gateway adapters. Each provider implements:
 *   createCheckout(payment, { lang }) -> what the frontend needs to send the customer to the
 *     gateway ({ redirectUrl } or { formUrl, fields }).
 *   parseWebhook(req) -> { valid: false } | { valid: true, ignore } |
 *     { valid: true, event: { paymentId | txnId, status, amount?, currency?, gatewayTxnId, raw } }
 *
 * Webhooks arrive at POST /api/v1/payments/webhook/:gateway with the raw body in req.body.
 *
 * - safepay: real integration (see safepay.js), used for SAFEPAY_METHODS when SAFEPAY_API_KEY is set.
 * - every other method: a stub checkout plus the generic relay webhook, HMAC-SHA256 over
 *   `${timestamp}.${rawBody}` with PAYMENT_WEBHOOK_SECRET, for your own payment relay service.
 */

export const ONLINE_METHODS = ['jazzcash', 'easypaisa', 'card', 'bank_transfer', 'wallet'];

const WEBHOOK_TOLERANCE_SECONDS = 300;

function relayVerify(req) {
  // No secret configured: the relay webhook is disabled, never accept an unsigned/empty-key payload.
  if (!env.PAYMENT_WEBHOOK_SECRET) return false;
  const ts = req.get('x-timestamp');
  const sig = req.get('x-signature');
  if (!ts || !sig || !/^\d{10}$/.test(ts) || !/^[a-f0-9]{64}$/i.test(sig)) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > WEBHOOK_TOLERANCE_SECONDS) return false;

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const expected = crypto
    .createHmac('sha256', env.PAYMENT_WEBHOOK_SECRET)
    .update(`${ts}.`)
    .update(raw)
    .digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

const relaySchema = z
  .object({
    paymentId: uuid,
    status: z.enum(['succeeded', 'failed']),
    amount: money,
    currency: z.string().length(3).optional(),
    gatewayTxnId: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/),
  })
  .passthrough();

const relay = {
  /** Stub checkout: replace with the real gateway API call. */
  async createCheckout(payment) {
    return {
      provider: payment.gateway,
      paymentId: payment.id,
      redirectUrl: null,
      instructions: 'Gateway integration pending: configure the adapter in src/modules/payments/gateways.js',
    };
  },
  parseWebhook(req) {
    if (!relayVerify(req)) return { valid: false };
    let body;
    try {
      body = relaySchema.parse(JSON.parse(req.body.toString('utf8')));
    } catch {
      throw AppError.badRequest('Invalid webhook payload');
    }
    return { valid: true, event: { ...body, raw: body } };
  },
};

export const gateways = {
  ...Object.fromEntries(ONLINE_METHODS.map((m) => [m, relay])),
  ...(safepayEnabled ? { safepay } : {}),
};

/** Which gateway handles a payment method. Stored in payments.gateway. */
export function gatewayFor(method) {
  return safepayEnabled && env.SAFEPAY_METHODS.includes(method) ? 'safepay' : method;
}
