import { supabaseAdmin } from '../config/supabase.js';
import { one } from '../config/db.js';
import { AppError } from '../utils/AppError.js';

/*
 * Roles (see README §6.5):
 *   agent (shown as "Counter staff", tied to a terminal) · conductor · manager · admin · super_admin
 * STAFF_ROLES   = everyone who works the counter: sell, board, see bookings and vouchers.
 * MANAGER_ROLES = managers and up: trip status and crew, replacement vouchers, reports.
 * ADMIN_ROLES   = prices, routes, buses, settings.
 * Conductors only reach the conductor screen (their own trips) and the trip report QR page.
 * Drivers only reach their own trips (/me/trips).
 */
export const STAFF_ROLES = ['agent', 'manager', 'admin', 'super_admin'];
export const MANAGER_ROLES = ['manager', 'admin', 'super_admin'];
export const ADMIN_ROLES = ['admin', 'super_admin'];
export const EMPLOYEE_ROLES = ['agent', 'driver', 'conductor', 'manager', 'admin', 'super_admin'];

function extractToken(req) {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token || token.length > 4096) return null;
  return token;
}

async function loadProfile(authUser) {
  let profile = await one(
    `SELECT id, full_name, email, phone, role, is_active, terminal_id FROM users WHERE id = $1`,
    [authUser.id],
  );
  if (!profile) {
    // Safety net for auth users created before the signup trigger existed.
    await one(
      `INSERT INTO users (id, full_name, email, email_verified, phone_verified)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        authUser.id,
        String(authUser.user_metadata?.full_name || 'Customer').slice(0, 120),
        authUser.email ?? null,
        Boolean(authUser.email_confirmed_at),
        Boolean(authUser.phone_confirmed_at),
      ],
    );
    profile = await one(
      `SELECT id, full_name, email, phone, role, is_active, terminal_id FROM users WHERE id = $1`,
      [authUser.id],
    );
  }
  return profile;
}

/**
 * Verifies the Supabase access token with Supabase Auth (so revoked /
 * deleted users are rejected) and attaches req.user = profile row.
 * Roles always come from our DB, never from the token's metadata.
 */
async function resolveUser(req) {
  const token = extractToken(req);
  if (!token) return null;

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) throw AppError.unauthorized('Invalid or expired session');

  const profile = await loadProfile(data.user);
  if (!profile) throw AppError.unauthorized('User profile not found');
  if (!profile.isActive) throw AppError.forbidden('This account has been deactivated');

  req.accessToken = token;
  return profile;
}

export async function requireAuth(req, _res, next) {
  const user = await resolveUser(req);
  if (!user) throw AppError.unauthorized();
  req.user = user;
  next();
}

/** Attaches req.user if a valid token is present; otherwise continues as guest. */
export async function optionalAuth(req, _res, next) {
  if (req.headers.authorization) req.user = await resolveUser(req);
  next();
}

export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) throw AppError.unauthorized();
    if (!roles.includes(req.user.role)) throw AppError.forbidden();
    next();
  };
}

export const isStaff = (user) => Boolean(user && STAFF_ROLES.includes(user.role));
export const isManager = (user) => Boolean(user && MANAGER_ROLES.includes(user.role));
export const isAdmin = (user) => Boolean(user && ADMIN_ROLES.includes(user.role));
export const isEmployee = (user) => Boolean(user && EMPLOYEE_ROLES.includes(user.role));
