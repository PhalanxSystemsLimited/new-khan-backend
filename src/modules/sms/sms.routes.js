/**
 * Phone verification for online booking (only asked when SMS is set up):
 *   GET  /phone/status?phone=...   { smsEnabled, verified }
 *   POST /phone/send-code { phone } sends a 6-digit code
 *   POST /phone/verify    { phone, code }
 * SMS status for the admin panel:
 *   GET  /phone/sms-status          managers and admins
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, MANAGER_ROLES } from '../../middleware/auth.js';
import { otpLimiter } from '../../middleware/rateLimit.js';
import { phone } from '../../utils/schemas.js';
import { smsEnabled } from '../../utils/sms.js';
import { isPhoneVerified, sendPhoneCode, smsStatus, verifyPhoneCode } from './sms.service.js';

const router = Router();

router.get('/status', requireAuth, validate({ query: z.object({ phone }).strict() }), async (req, res) => {
  res.json({ data: { smsEnabled: smsEnabled(), verified: await isPhoneVerified(req.user.id, req.valid.query.phone) } });
});

router.post('/send-code', requireAuth, otpLimiter, validate({ body: z.object({ phone }).strict() }), async (req, res) => {
  res.json({ data: await sendPhoneCode(req.user, req.valid.body.phone) });
});

router.post(
  '/verify',
  requireAuth,
  otpLimiter,
  validate({ body: z.object({ phone, code: z.string().trim().regex(/^\d{6}$/, 'The code has 6 digits') }).strict() }),
  async (req, res) => {
    res.json({ data: await verifyPhoneCode(req.user, req.valid.body.phone, req.valid.body.code) });
  },
);

router.get('/sms-status', requireAuth, requireRole(...MANAGER_ROLES), async (_req, res) => {
  res.json({ data: await smsStatus() });
});

export default router;
