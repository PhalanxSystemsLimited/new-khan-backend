import { createHash } from 'node:crypto';
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

/*
 * Checked tokens are remembered for a short time (in this server's memory), so every click does not wait for
 * a call to Supabase Auth. Only "this token is genuine" is remembered: the role and "account active" are read
 * from our database on every request, so a deactivated account or a role change takes effect at once.
 * A sign-out or password change on another device reaches this server within AUTH_CACHE_MS at most.
 */
const AUTH_CACHE_MS = 60_000;
const AUTH_CACHE_MAX = 1000;
const authCache = new Map(); // sha256(token) -> { user, until }
const tokenKey = (token) => createHash('sha256').update(token).digest('hex');

/** The token's own expiry (ms), read from its payload. Only used to never remember a token past its expiry. */
function tokenExpiry(token) {
  try {
    const exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).exp;
    return Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function authUser(token) {
  const key = tokenKey(token);
  const now = Date.now();
  const hit = authCache.get(key);
  if (hit && hit.until > now) return hit.user;
  if (hit) authCache.delete(key);

  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) throw AppError.unauthorized('Invalid or expired session');

  const until = Math.min(now + AUTH_CACHE_MS, tokenExpiry(token));
  if (until > now) {
    if (authCache.size >= AUTH_CACHE_MAX) {
      for (const [k, v] of authCache) if (v.until <= now) authCache.delete(k);
      if (authCache.size >= AUTH_CACHE_MAX) authCache.delete(authCache.keys().next().value); // the oldest
    }
    authCache.set(key, { user: data.user, until });
  }
  return data.user;
}

/** Forgets every remembered token of this user (sign-out, password change). */
export function forgetUserTokens(userId) {
  for (const [k, v] of authCache) if (v.user.id === userId) authCache.delete(k);
}

/**
 * Verifies the Supabase access token with Supabase Auth (so revoked /
 * deleted users are rejected; remembered for up to a minute, see above) and attaches req.user = profile row.
 * Roles always come from our DB, never from the token's metadata.
 */
async function resolveUser(req) {
  const token = extractToken(req);
  if (!token) return null;

  const profile = await loadProfile(await authUser(token));
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
