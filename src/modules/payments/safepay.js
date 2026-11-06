import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { logger } from '../../utils/logger.js';

/*
 * Safepay Express Checkout (https://safepay-docs.netlify.app/build-your-integration/express-checkout),
 * the same calls as Safepay's official Node SDK (@sfpy/node-core):
 *
 * 1. createCheckout():
 *    a. POST /order/payments/v3/  (header X-SFPY-MERCHANT-SECRET) creates a payment session for the
 *       booking amount, in paisa. Its tracker token (track_...) is stored on the payment row (gateway_txn_id).
 *    b. POST /client/passport/v1/token  gives a short-lived (1 hour) authentication token, "tbt".
 *    c. The customer is sent to <host>/embedded/?environment&tracker&tbt&source=hosted&redirect_url&cancel_url.
 * 2. Safepay sends the customer back to GET /api/v1/payments/safepay/return/<lang>?tracker=track_...
 *    The server asks Safepay for that tracker (GET /reporter/api/v1/payments/{tracker}) and only
 *    confirms the booking if its state is TRACKER_ENDED (paid) for exactly the booking amount.
 * 3. Safepay also sends a payment.succeeded webhook to POST /api/v1/payments/webhook/safepay with
 *    X-SFPY-SIGNATURE = HMAC-SHA512(webhook shared secret), hex.
 *
 * A payment is only ever looked up by a tracker this server created and stored.
 */

const HOST = {
  sandbox: 'https://sandbox.api.getsafepay.com',
  production: 'https://api.getsafepay.com',
};
const CHECKOUT_URL = {
  sandbox: 'https://sandbox.api.getsafepay.com/embedded/',
  production: 'https://getsafepay.com/embedded/',
};

const TRACKER_RE = /^[A-Za-z0-9_-]{1,120}$/;
/** Paid. See https://safepay-docs.netlify.app/concepts/tracker-states */
export const PAID_STATE = 'TRACKER_ENDED';

export const safepayEnabled = Boolean(env.SAFEPAY_API_KEY);

const trimSlash = (u) => String(u ?? '').replace(/\/+$/, '');
const appUrl = () => trimSlash(env.APP_URL);
const apiUrl = () => trimSlash(env.API_PUBLIC_URL);

/** Rupees (numeric string from Postgres) to paisa, Safepay's unit. */
const toPaisa = (amount) => Math.round(Number(amount) * 100);

/** Frontend page URL, matching bookUrl() in the frontend. */
export function frontendUrl(lang, page, params = {}) {
  const q = new URLSearchParams(params).toString();
  return `${appUrl()}/${lang}/book${page ? `/${page}` : ''}${q ? `?${q}` : ''}`;
}

export function isValidTracker(t) {
  return typeof t === 'string' && TRACKER_RE.test(t);
}

/** One call to Safepay's API with the merchant secret. Throws a 502 AppError on any failure. */
async function sfpy(method, path, body, what) {
  let res;
  let json = null;
  try {
    res = await fetch(`${HOST[env.SAFEPAY_ENV]}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'X-SFPY-MERCHANT-SECRET': env.SAFEPAY_SECRET_KEY,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    json = await res.json().catch(() => null);
  } catch (err) {
    logger.error({ err: err.message, what }, 'Safepay request failed');
    throw new AppError(502, 'The payment gateway is not responding. Please try again.', 'GATEWAY_ERROR');
  }
  if (!res.ok || !json?.data) {
    // Log Safepay's status and error message only; never keys.
    logger.error({ what, status: res.status, error: json?.status?.errors ?? json?.status ?? null }, 'Safepay request rejected');
    throw new AppError(502, 'The payment gateway could not start this payment. Please try again.', 'GATEWAY_ERROR');
  }
  return json.data;
}

/** Payment session for the amount; returns its tracker token (track_...). */
async function createSession(payment) {
  const data = await sfpy(
    'POST',
    '/order/payments/v3/',
    {
      merchant_api_key: env.SAFEPAY_API_KEY,
      intent: 'CYBERSOURCE',
      mode: 'payment',
      currency: payment.currency,
      amount: toPaisa(payment.amount),
      // Safepay only accepts known metadata keys ("unsupported meta key" otherwise); order_id is one of them.
      metadata: { order_id: payment.id },
    },
    'create session',
  );
  const token = data?.tracker?.token;
  if (!isValidTracker(token)) {
    logger.error('Safepay session response had no tracker');
    throw new AppError(502, 'The payment gateway could not start this payment. Please try again.', 'GATEWAY_ERROR');
  }
  return token;
}

/** Short-lived authentication token ("tbt") for the hosted checkout page. */
async function createPassport() {
  const tbt = await sfpy('POST', '/client/passport/v1/token', null, 'passport');
  if (typeof tbt !== 'string' || !tbt) throw new AppError(502, 'The payment gateway could not start this payment. Please try again.', 'GATEWAY_ERROR');
  return tbt;
}

/**
 * The tracker as Safepay sees it: { state, amount (rupees), currency }.
 * The source of truth for whether a payment went through.
 */
export async function fetchTracker(tracker) {
  const data = await sfpy('GET', `/reporter/api/v1/payments/${encodeURIComponent(tracker)}`, null, 'fetch tracker');
  const t = data.tracker && typeof data.tracker === 'object' ? data.tracker : data;
  const total = t.purchase_totals?.base_amount ?? t.purchase_totals?.quote_amount ?? {};
  return {
    state: String(t.state ?? ''),
    amount: typeof total.amount === 'number' ? total.amount / 100 : null,
    currency: total.currency ?? null,
  };
}

async function createCheckout(payment, { lang = 'en' } = {}) {
  let tracker = payment.gatewayTxnId;
  // Trackers from the old v1 integration (no "track_" prefix) cannot be used with this checkout: start a new session.
  if (!tracker || !tracker.startsWith('track_')) {
    const created = await createSession(payment);
    // Keep the first tracker if two requests raced on the same payment.
    const saved = await one(
      `UPDATE payments SET gateway_txn_id = $2
       WHERE id = $1 AND (gateway_txn_id IS NULL OR gateway_txn_id NOT LIKE 'track\\_%')
       RETURNING gateway_txn_id`,
      [payment.id, created],
    );
    tracker = saved?.gatewayTxnId ?? (await one(`SELECT gateway_txn_id FROM payments WHERE id = $1`, [payment.id])).gatewayTxnId;
  }

  const tbt = await createPassport();
  const params = new URLSearchParams({
    environment: env.SAFEPAY_ENV,
    tracker,
    tbt,
    source: 'hosted',
    // No query string of our own: Safepay appends ?tracker=..., which must not collide with another '?'.
    redirect_url: `${apiUrl()}/api/v1/payments/safepay/return/${lang === 'ur' ? 'ur' : 'en'}`,
    cancel_url: frontendUrl(lang, 'pay', { ref: payment.bookingId }),
  });
  return {
    provider: 'safepay',
    paymentId: payment.id,
    redirectUrl: `${CHECKOUT_URL[env.SAFEPAY_ENV]}?${params}`,
  };
}

const hmac512 = (data) => crypto.createHmac('sha512', env.SAFEPAY_WEBHOOK_SECRET).update(data).digest();

/** Constant-time check of a hex signature against HMAC-SHA512 of any of the given byte strings. */
function signatureMatches(given, candidates) {
  if (typeof given !== 'string' || !/^[a-f0-9]{128}$/i.test(given)) return false;
  const sig = Buffer.from(given, 'hex');
  return candidates.some((c) => crypto.timingSafeEqual(sig, hmac512(c)));
}

/**
 * Returns { valid: false } for a bad signature, { valid: true, ignore } for events we do not act on,
 * or { valid: true, event } for a successful payment.
 * Failure events are ignored on purpose: the customer can retry on the same tracker, and the booking
 * hold expiry already releases unpaid seats.
 */
function parseWebhook(req) {
  if (!env.SAFEPAY_WEBHOOK_SECRET) return { valid: false };
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return { valid: false };
  }
  const data = body?.data;
  if (!data || typeof data !== 'object') return { valid: false };
  // Safepay's docs sign the JSON payload; accept the raw bytes, the whole body, or its data object (older webhooks).
  if (!signatureMatches(req.get('x-sfpy-signature'), [raw, JSON.stringify(body), JSON.stringify(data)])) return { valid: false };

  const n = data.notification && typeof data.notification === 'object' ? data.notification : data;
  const tracker = n.tracker ?? data.tracker;
  const type = String(body.type ?? data.type ?? '');
  if (!isValidTracker(tracker)) return { valid: true, ignore: 'no tracker' };
  if (type !== 'payment.succeeded') return { valid: true, ignore: `event ${type || 'unknown'}` };
  if (n.state && n.state !== PAID_STATE) return { valid: true, ignore: `state ${n.state}` };

  return {
    valid: true,
    event: {
      txnId: tracker,
      status: 'succeeded',
      gatewayTxnId: tracker,
      // Safepay amounts are in paisa; settlePayment checks them against the booking.
      amount: typeof n.amount === 'number' ? n.amount / 100 : undefined,
      currency: typeof n.currency === 'string' ? n.currency : undefined,
      raw: { source: 'webhook', type, ...data },
    },
  };
}

export const safepay = { createCheckout, parseWebhook };
