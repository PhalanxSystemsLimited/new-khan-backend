import crypto from 'node:crypto';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import pinoHttp from 'pino-http';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { logger } from './utils/logger.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { AppError } from './utils/AppError.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';

import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/users.routes.js';
import locationRoutes from './modules/locations/locations.routes.js';
import routeRoutes from './modules/routes/routes.routes.js';
import fleetRoutes from './modules/fleet/fleet.routes.js';
import fareRoutes from './modules/fares/fares.routes.js';
import scheduleRoutes from './modules/schedules/schedules.routes.js';
import tripRoutes from './modules/trips/trips.routes.js';
import bookingRoutes, { ticketsRouter } from './modules/bookings/bookings.routes.js';
import paymentRoutes, { paymentWebhook, safepayReturn } from './modules/payments/payments.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';
import { adminContentRouter, publicContentRouter } from './modules/content/content.routes.js';
import {
  adminRoundTripsRouter, adminVouchersRouter, publicReportRouter, reportSettingsRouter,
} from './modules/roundtrips/roundtrips.routes.js';
import tripVoucherRoutes from './modules/tripvouchers/tripVouchers.routes.js';
import conductorRoutes from './modules/conductor/conductor.routes.js';
import { adminEmployeesRouter, crewRouter } from './modules/employees/employees.routes.js';
import { dayPlanRouter } from './modules/dayplan/dayPlan.routes.js';
import { homeRouter } from './modules/home/home.routes.js';
import { runExpiryOnce } from './jobs/expireBookings.js';

export function createApp() {
  const app = express();

  // ---- Core hardening ----
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple'); // no nested objects/prototype tricks in query strings
  app.set('json spaces', 0);

  app.use(
    pinoHttp({
      logger,
      genReqId: (req, res) => {
        const incoming = req.headers['x-request-id'];
        const id = typeof incoming === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
        res.setHeader('X-Request-Id', id);
        return id;
      },
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: env.isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
    }),
  );

  // ---- Safepay return: a browser navigation (form POST or GET) from Safepay's site, so it sits before CORS ----
  const safepayReturnPath = ['/api/v1/payments/safepay/return', '/api/v1/payments/safepay/return/:lang'];
  app.get(safepayReturnPath, globalLimiter, safepayReturn);
  app.post(safepayReturnPath, globalLimiter, express.urlencoded({ extended: false, limit: '8kb' }), safepayReturn);

  app.use(
    cors({
      origin(origin, cb) {
        // Allow server-to-server / curl (no Origin header) and whitelisted browser origins.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        if (!env.isProd && /^http:\/\/localhost:\d+$/.test(origin)) return cb(null, true);
        return cb(new Error('CORS_NOT_ALLOWED'));
      },
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use(compression());

  // ---- Health check (no rate limit, no auth) ----
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded' });
    }
  });

  // ---- Scheduled job for serverless hosts (Vercel Cron, or any scheduler calling it every few minutes) ----
  // Off unless CRON_SECRET is set; a long-running server runs the same job in-process every minute instead.
  app.get('/api/v1/internal/expire-bookings', async (req, res) => {
    if (!env.CRON_SECRET) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    const sent = Buffer.from(String(req.headers.authorization ?? ''));
    const want = Buffer.from(`Bearer ${env.CRON_SECRET}`);
    if (sent.length !== want.length || !crypto.timingSafeEqual(sent, want)) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    res.set('Cache-Control', 'no-store');
    res.json({ data: await runExpiryOnce() });
  });

  // ---- Payment webhooks need the raw body for signature checks: mount before express.json ----
  app.post(
    '/api/v1/payments/webhook/:gateway',
    express.raw({ type: 'application/json', limit: '64kb' }),
    paymentWebhook,
  );

  app.use(globalLimiter);
  // Website content saved from the admin panel (policy texts in two languages) is larger than any other request.
  const jsonSmall = express.json({ limit: '50kb', strict: true });
  const jsonContent = express.json({ limit: '1mb', strict: true });
  app.use((req, res, next) => (req.path.startsWith('/api/v1/admin/content/') ? jsonContent : jsonSmall)(req, res, next));
  app.use((req, _res, next) => {
    // Only JSON bodies are accepted on write requests.
    if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.headers['content-length'] !== '0' && req.body === undefined && req.headers['content-type']) {
      return next(new AppError(415, 'Content-Type must be application/json', 'UNSUPPORTED_MEDIA_TYPE'));
    }
    next();
  });

  // ---- API v1 ----
  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/', locationRoutes); // /cities, /terminals
  api.use('/routes', routeRoutes);
  api.use('/fleet', fleetRoutes);
  api.use('/fares', fareRoutes);
  api.use('/schedules', scheduleRoutes);
  api.use('/trips', tripRoutes);
  api.use('/bookings', bookingRoutes);
  api.use('/tickets', ticketsRouter);
  api.use('/payments', paymentRoutes);
  api.use('/content', publicContentRouter);
  api.use('/admin/content', adminContentRouter);
  api.use('/admin/round-trips', adminRoundTripsRouter);
  api.use('/admin/vouchers', adminVouchersRouter);
  api.use('/admin/report-settings', reportSettingsRouter);
  api.use('/reports', publicReportRouter);
  api.use('/trip-vouchers', tripVoucherRoutes);
  api.use('/conductor', conductorRoutes);
  api.use('/admin/employees', adminEmployeesRouter);
  api.use('/admin/day-plan', dayPlanRouter);
  api.use('/', homeRouter); // /counter/departures, /me/trips, /board
  api.use('/employees', crewRouter);
  api.use('/admin', adminRoutes);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
