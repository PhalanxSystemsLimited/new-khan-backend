import { ZodError } from 'zod';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

// Friendly messages for known unique constraints.
const UNIQUE_MESSAGES = {
  tickets_trip_seat_active_uq: 'One or more selected seats are no longer available. Please choose different seats.',
  users_email_uq: 'This email is already in use.',
  users_phone_uq: 'This phone number is already in use.',
  promo_codes_code_uq: 'A promo code with this code already exists.',
  trips_schedule_departure_uq: 'A trip for this schedule already exists at that time.',
  payments_idempotency_key_key: 'This payment request was already submitted.',
  reviews_booking_id_key: 'You have already reviewed this booking.',
};

function fromPg(err) {
  switch (err.code) {
    case '23505':
      return new AppError(409, UNIQUE_MESSAGES[err.constraint] || 'A record with these details already exists.', 'DUPLICATE');
    case '23503':
      return new AppError(400, 'A referenced record does not exist or is still in use.', 'INVALID_REFERENCE');
    case '23514':
    case '23502':
      return new AppError(400, 'The data provided violates a validation rule.', 'CONSTRAINT_VIOLATION');
    case '22P02':
    case '22007':
    case '22008':
    case '22003':
      return new AppError(400, 'Invalid value in request.', 'INVALID_VALUE');
    case 'NKG01':
      // Side-by-side seat rule (validate_ticket_seat_neighbours): the message names both seats.
      return new AppError(409, err.message, 'SEAT_GENDER');
    case 'P0001':
      // RAISE EXCEPTION from our own triggers: messages are written for users.
      return new AppError(422, err.message, 'BUSINESS_RULE');
    case '40001':
    case '40P01':
    case '55P03':
      return new AppError(503, 'The system is busy, please retry.', 'RETRY');
    case '57014':
      return new AppError(503, 'The request took too long, please retry.', 'TIMEOUT');
    case '42P01': // undefined table
    case '42703': // undefined column
    case '42883': // undefined function
      // The code is newer than the database: a file in db/migrations has not been run yet (logged in full).
      return new AppError(503, 'The database is missing an update. Run the newest files in backend/db/migrations.', 'DB_MIGRATION_MISSING');
    default:
      return null;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  let appErr = null;

  if (err instanceof AppError) appErr = err;
  else if (err instanceof ZodError) {
    appErr = new AppError(
      400,
      'Validation failed',
      'VALIDATION_ERROR',
      err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    );
  } else if (err?.type === 'entity.parse.failed') {
    appErr = AppError.badRequest('Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    appErr = new AppError(413, 'Request body too large', 'PAYLOAD_TOO_LARGE');
  } else if (err?.message === 'CORS_NOT_ALLOWED') {
    appErr = AppError.forbidden('Origin not allowed');
  } else if (typeof err?.code === 'string' && /^[0-9A-Z]{5}$/.test(err.code)) {
    appErr = fromPg(err);
  }

  if (!appErr || appErr.statusCode >= 500) {
    req.log?.error({ err }, 'Unhandled error');
  }

  if (!appErr) {
    appErr = new AppError(500, 'Internal server error', 'INTERNAL');
  }

  const body = { error: { code: appErr.code, message: appErr.message } };
  if (appErr.details) body.error.details = appErr.details;
  if (req.id) body.error.requestId = req.id;
  if (!env.isProd && appErr.statusCode === 500) body.error.debug = err?.message;

  res.status(appErr.statusCode).json(body);
}
