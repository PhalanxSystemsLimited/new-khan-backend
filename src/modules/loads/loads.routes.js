/**
 * Extra load slips (see loads.service.js for the rules).
 *   GET  /load-slips/find?q=      the booking from a reference (NK…), ticket number (NK-…-…), scanned ticket QR or LD number,
 *                                 with its slips and whether this user can add one now          counter staff, managers
 *   POST /load-slips              add a counter slip { bookingId, amount, pieces?, weightKg?, note? }  counter staff, managers
 *   GET  /load-slips/:id          one slip, for the screen and the printed slip        counter staff, managers, the trip's conductor
 *   POST /load-slips/:id/cancel   cancel { reason }                                     the same (rules in the service)
 * The conductor adds his slips from the conductor screen: POST /conductor/tickets/:ticketId/load-slips.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, MANAGER_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { audit } from '../../utils/audit.js';
import { bigIdParam, uuid } from '../../utils/schemas.js';
import { addCounterSlip, cancelSlip, findBooking, slipForPrint } from './loads.service.js';
import { ticketQrFor } from '../bookings/ticketQr.js';

export const loadSlipsRouter = Router();
const counter = requireRole(...STAFF_ROLES);
const counterOrConductor = requireRole(...new Set([...STAFF_ROLES, ...MANAGER_ROLES, 'conductor']));

/** What staff type for a slip (shared with the conductor's route). */
export const slipBody = {
  amount: z.number().int().min(1, 'Enter the amount taken (Rs)').max(100_000),
  pieces: z.number().int().min(1).max(99).nullable().optional(),
  weightKg: z.number().positive().max(9999).multipleOf(0.1).nullable().optional(),
  note: z.string().trim().max(200).nullable().optional(),
};

loadSlipsRouter.get(
  '/find',
  requireAuth,
  counter,
  validate({ query: z.object({ q: z.string().trim().min(1, 'Type a booking reference or ticket number').max(300) }).strict() }),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: await findBooking(req.valid.query.q, req.user) });
  },
);

loadSlipsRouter.post(
  '/',
  requireAuth,
  counter,
  validate({ body: z.object({ bookingId: uuid, ...slipBody }).strict() }),
  async (req, res) => {
    const b = req.valid.body;
    const out = await withTransaction(async (client) => {
      const r = await addCounterSlip(client, { ...b, user: req.user });
      await audit({ req, client, action: 'load_slip.add', entityType: 'load_slip', entityId: r.slip.slipNo, newData: { ...b, pnr: r.booking.pnr, takenBy: 'counter' } });
      return r.slip;
    });
    res.status(201).json({ data: out });
  },
);

loadSlipsRouter.get('/:id', requireAuth, counterOrConductor, validate({ params: bigIdParam }), async (req, res) => {
  const s = await slipForPrint(req.valid.params.id, req.user);
  // The ticket's own QR (staff scanning it see the booking and its load slips).
  const qr = await ticketQrFor({ id: s.bookingId, status: s.bookingStatus }).catch(() => null);
  res.set('Cache-Control', 'no-store');
  res.json({ data: { ...s, qrSvg: qr?.svg ?? null, qrUrl: qr?.url ?? null } });
});

loadSlipsRouter.post(
  '/:id/cancel',
  requireAuth,
  counterOrConductor,
  validate({ params: bigIdParam, body: z.object({ reason: z.string().trim().min(3, 'Write why it is cancelled').max(300) }).strict() }),
  async (req, res) => {
    const out = await withTransaction(async (client) => {
      const s = await cancelSlip(client, { slipId: req.valid.params.id, reason: req.valid.body.reason, user: req.user });
      await audit({ req, client, action: 'load_slip.cancel', entityType: 'load_slip', entityId: s.slipNo, newData: { reason: req.valid.body.reason, amount: s.amount, takenBy: s.takenBy } });
      return s;
    });
    res.json({ data: out });
  },
);
