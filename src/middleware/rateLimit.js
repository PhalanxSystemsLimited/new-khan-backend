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

/** The request carries a sign-in token (checked later, in requireAuth / optionalAuth). */
const hasToken = (req) => typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ');

/**
 * Applies to every request, per internet address. Visitors who are not signed in: 300 per 15 minutes.
 * Requests with a sign-in token are counted separately and get a much higher ceiling, because the staff of a
 * terminal (counter PCs, cargo desk, manager) usually share one office connection. Each signed-in person is also
 * limited on their own (accountLimiter), and made-up tokens are stopped by badTokenLimiter.
 */
export const globalLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: (req) => (hasToken(req) ? 3000 : 300),
  keyGenerator: (req) => `${hasToken(req) ? 'signed-in' : 'visitor'}:${req.ip}`,
  message: message('Too many requests, please try again later.'),
});

/**
 * Sign-in tokens that turn out to be invalid, per internet address: 30 per 15 minutes. Only refused tokens count
 * (answers other than 401 are not counted), so a token that expires now and then never gets near it.
 */
export const badTokenLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 30,
  skip: (req) => !hasToken(req),
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.statusCode !== 401,
  message: message('Too many requests with an invalid sign-in. Sign in again, or wait 15 minutes.'),
});

/**
 * Each signed-in person: 900 requests per 15 minutes (about one a second), whatever connection they use. A busy
 * counter clerk uses a fraction of it; one account that runs wild is stopped without stopping their colleagues.
 * Used by requireAuth / optionalAuth once the person is known (countAccount below).
 */
const accountLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 900,
  keyGenerator: (req) => `u:${req.user.id}`,
  handler: (_req, res, _next, options) => res.status(options.statusCode).json(
    message('Too many requests from this account. Wait a minute, then try again.'),
  ),
});

/** Counts the request against its signed-in person once (a request can pass through requireAuth more than once). */
export function countAccount(req, res, next) {
  if (!req.user || req.accountCounted) return next();
  req.accountCounted = true;
  return accountLimiter(req, res, next);
}

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

/** "Apply promo code" on the website: a customer tries a few codes, nobody guesses thousands. */
export const promoLimiter = rateLimit({
  ...base,
  windowMs: 15 * 60 * 1000,
  limit: 15,
  keyGenerator: userOrIp,
  message: message('Too many promo codes tried. Please wait a few minutes and try again.'),
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
