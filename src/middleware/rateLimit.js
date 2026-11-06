import rateLimit from 'express-rate-limit';

/*
 * In-memory rate limiting (fits a single Node process on Hostinger).
 * If you later run several instances, plug a shared store such as
 * rate-limit-redis into each limiter via the `store` option.
 *
 * IMPORTANT: app.set('trust proxy', N) must match your proxy setup so
 * req.ip is the real client IP and not the proxy's.
 */

const message = (msg) => ({
  error: { code: 'RATE_LIMITED', message: msg },
});

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

/** Key by authenticated user when available, otherwise by IP. */
const userOrIp = (req) => (req.user ? `u:${req.user.id}` : `ip:${req.ip}`);

/** Applies to every request. */
export const globalLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: message('Too many requests, please try again later.'),
});

/** Login / signup / refresh: brute-force protection. */
export const authLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  message: message('Too many authentication attempts, please try again in 15 minutes.'),
});

/** OTP / password-reset senders cost money (SMS) and can be abused for spam. */
export const otpLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  keyGenerator: (req) => {
    const target = String(req.body?.phone || req.body?.email || '').toLowerCase().slice(0, 64);
    return `${req.ip}|${target}`;
  },
  message: message('Too many codes requested. Please wait before trying again.'),
});

/** Creating bookings holds seats, so limit per user. */
export const bookingLimiter = rateLimit({
  ...base,
  windowMs: 60 * 60 * 1000,
  limit: 20,
  keyGenerator: userOrIp,
  message: message('Too many booking attempts. Please try again later.'),
});

/** Public PNR lookup: stops enumeration of booking references. */
export const lookupLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: message('Too many lookups, please try again later.'),
});

/** Payment initiation. */
export const paymentLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: userOrIp,
  message: message('Too many payment attempts, please try again later.'),
});

/** Public search endpoints. */
export const searchLimiter = rateLimit({
  ...base,
  windowMs: 60 * 1000,
  limit: 60,
  message: message('Too many searches, please slow down.'),
});
