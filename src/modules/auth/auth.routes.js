import { Router } from 'express';
import { z } from 'zod';
import { supabaseAdmin, supabasePublic } from '../../config/supabase.js';
import { env } from '../../config/env.js';
import { one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth } from '../../middleware/auth.js';
import { authLimiter, otpLimiter } from '../../middleware/rateLimit.js';
import { AppError } from '../../utils/AppError.js';
import { cnic, email, password, personName, phone } from '../../utils/schemas.js';
import { cnicDisplay } from '../../utils/cnic.js';

const router = Router();

const sessionPayload = (session, user) => ({
  accessToken: session?.access_token,
  refreshToken: session?.refresh_token,
  expiresAt: session?.expires_at,
  tokenType: 'bearer',
  user: user ? { id: user.id, email: user.email, phone: user.phone } : undefined,
});

// Generic messages: never reveal whether an account exists.
const INVALID_LOGIN = 'Invalid email or password';

const accountExists = () =>
  new AppError(
    409,
    'An account with this email already exists. Sign in, or if you have not verified your email yet, press "Verify now" to get a new link.',
    'ACCOUNT_EXISTS',
  );

const signupSchema = z
  .object({
    fullName: personName,
    email,
    password,
    phone, // required
    // Optional. When given, every booking made with this account carries it (checked for counter refunds).
    cnic: cnic.optional(),
  })
  .strict();

router.post('/signup', authLimiter, validate({ body: signupSchema }), async (req, res) => {
  const { fullName, email: mail, password: pwd, phone: tel, cnic: id } = req.valid.body;
  const { data, error } = await supabasePublic().auth.signUp({
    email: mail,
    password: pwd,
    options: {
      data: { full_name: fullName },
      emailRedirectTo: env.AUTH_REDIRECT_URL,
    },
  });
  if (error) {
    req.log.info({ code: error.code, status: error.status }, 'signup failed');
    // Say why, where it is safe to: Supabase's email limit and weak passwords are not secrets.
    if (error.code === 'over_email_send_rate_limit' || error.status === 429) {
      throw new AppError(429, 'Too many accounts were created in the last hour. Please try again later, or sign in with a phone code.', 'TOO_MANY_SIGNUPS');
    }
    if (error.code === 'weak_password') {
      throw AppError.badRequest('That password is too weak. Use at least 8 characters with upper-case, lower-case and a number.');
    }
    if (error.code === 'email_address_invalid') throw AppError.badRequest('That email address cannot be used. Please check it.');
    if (error.code === 'user_already_exists' || error.code === 'email_exists') throw accountExists();
    throw AppError.badRequest('Unable to create account. The email may already be registered or the password is too weak.');
  }

  // Email already registered and confirmed: Supabase answers with a placeholder user that has no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) throw accountExists();

  if (data.user) {
    // The profile row is created by the auth trigger. Phone is stored unverified, for booking contact purposes.
    await one(`UPDATE users SET phone = $2 WHERE id = $1 AND phone IS NULL`, [data.user.id, tel]).catch(() => {});
    if (id) await one(`UPDATE users SET cnic = $2 WHERE id = $1 AND cnic IS NULL`, [data.user.id, cnicDisplay(id)]).catch(() => {});
  }

  res.status(201).json({
    message: data.session
      ? 'Account created.'
      : 'Account created. Please check your email to confirm your address.',
    ...(data.session ? sessionPayload(data.session, data.user) : {}),
  });
});

router.post(
  '/login',
  authLimiter,
  validate({ body: z.object({ email, password: z.string().min(1).max(72) }).strict() }),
  async (req, res) => {
    const { data, error } = await supabasePublic().auth.signInWithPassword(req.valid.body);
    // Supabase only says "not confirmed" once the password is right, so this reveals nothing to a stranger.
    if (error?.code === 'email_not_confirmed') {
      throw new AppError(403, 'Your email is not verified yet. Press "Verify now" to get a new verification link.', 'EMAIL_NOT_CONFIRMED');
    }
    if (error || !data.session) throw AppError.unauthorized(INVALID_LOGIN);
    res.json(sessionPayload(data.session, data.user));
  },
);

// ---- Phone OTP login (requires an SMS provider configured in Supabase Auth) ----
router.post(
  '/otp/send',
  otpLimiter,
  validate({ body: z.object({ phone }).strict() }),
  async (req, res) => {
    const { error } = await supabasePublic().auth.signInWithOtp({ phone: req.valid.body.phone });
    if (error) req.log.warn({ code: error.code }, 'OTP send failed');
    // Same response either way to avoid leaking information.
    res.json({ message: 'If the number is valid, a verification code has been sent.' });
  },
);

router.post(
  '/otp/verify',
  authLimiter,
  validate({ body: z.object({ phone, token: z.string().regex(/^\d{6}$/, 'Code must be 6 digits') }).strict() }),
  async (req, res) => {
    const { data, error } = await supabasePublic().auth.verifyOtp({
      phone: req.valid.body.phone,
      token: req.valid.body.token,
      type: 'sms',
    });
    if (error || !data.session) throw AppError.unauthorized('Invalid or expired code');
    res.json(sessionPayload(data.session, data.user));
  },
);

router.post(
  '/refresh',
  authLimiter,
  validate({ body: z.object({ refreshToken: z.string().min(10).max(512) }).strict() }),
  async (req, res) => {
    const { data, error } = await supabasePublic().auth.refreshSession({
      refresh_token: req.valid.body.refreshToken,
    });
    if (error || !data.session) throw AppError.unauthorized('Session expired, please log in again');
    res.json(sessionPayload(data.session, data.user));
  },
);

router.post('/logout', requireAuth, async (req, res) => {
  // Revokes all refresh tokens for this session.
  const { error } = await supabaseAdmin.auth.admin.signOut(req.accessToken, 'global');
  if (error) req.log.warn({ code: error.code }, 'logout failed');
  res.json({ message: 'Logged out' });
});

/** Send the account-confirmation email again (the first one was lost, expired, or never opened). */
router.post(
  '/resend-confirmation',
  otpLimiter,
  validate({ body: z.object({ email }).strict() }),
  async (req, res) => {
    const { error } = await supabasePublic().auth.resend({
      type: 'signup',
      email: req.valid.body.email,
      options: { emailRedirectTo: env.AUTH_REDIRECT_URL },
    });
    if (error) {
      req.log.warn({ code: error.code, status: error.status }, 'resend confirmation failed');
      if (error.code === 'over_email_send_rate_limit' || error.status === 429) {
        throw new AppError(429, 'Too many emails were sent in a short time. Please wait a few minutes and try again.', 'TOO_MANY_EMAILS');
      }
    }
    // Same answer otherwise, so it never reveals whether an account exists.
    res.json({ message: 'If this email has an account that is not verified yet, a new verification link has been sent.' });
  },
);

router.post(
  '/password/forgot',
  otpLimiter,
  validate({ body: z.object({ email }).strict() }),
  async (req, res) => {
    const { error } = await supabasePublic().auth.resetPasswordForEmail(req.valid.body.email, {
      redirectTo: env.AUTH_REDIRECT_URL,
    });
    if (error) req.log.warn({ code: error.code }, 'password reset email failed');
    res.json({ message: 'If an account exists for this email, a reset link has been sent.' });
  },
);

/** Set a new password. Works for a logged-in user or the recovery session from the reset email. */
router.post(
  '/password/reset',
  authLimiter,
  requireAuth,
  validate({ body: z.object({ password }).strict() }),
  async (req, res) => {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.user.id, {
      password: req.valid.body.password,
    });
    if (error) throw AppError.badRequest('Unable to update password');
    // Invalidate other sessions after a password change.
    await supabaseAdmin.auth.admin.signOut(req.accessToken, 'others').catch(() => {});
    res.json({ message: 'Password updated' });
  },
);

export default router;
