import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { buildUpdate } from '../../utils/sql.js';
import { audit } from '../../utils/audit.js';
import { busClass, idParam, intId, isoDate, money } from '../../utils/schemas.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];

router.get(
  '/',
  validate({ query: z.object({ routeId: intId, busClass: busClass.optional() }).strict() }),
  async (req, res) => {
    const { routeId, busClass: cls } = req.valid.query;
    const { rows } = await query(
      `SELECT f.id, f.route_id, f.bus_class, f.amount, f.currency, f.valid_from, f.valid_to,
              f.from_stop_id, ft.name AS from_terminal, f.to_stop_id, tt.name AS to_terminal
       FROM fares f
       JOIN route_stops fs ON fs.id = f.from_stop_id JOIN terminals ft ON ft.id = fs.terminal_id
       JOIN route_stops ts ON ts.id = f.to_stop_id   JOIN terminals tt ON tt.id = ts.terminal_id
       WHERE f.route_id = $1 AND ($2::bus_class IS NULL OR f.bus_class = $2)
         AND (f.valid_to IS NULL OR f.valid_to >= CURRENT_DATE)
       ORDER BY f.bus_class, fs.stop_order, ts.stop_order, f.valid_from`,
      [routeId, cls ?? null],
    );
    res.json({ data: rows });
  },
);

const fareSchema = z
  .object({
    routeId: intId,
    fromStopId: intId,
    toStopId: intId,
    busClass,
    amount: money,
    validFrom: isoDate.optional(),
    validTo: isoDate.nullable().optional(),
  })
  .strict()
  .refine((f) => f.fromStopId !== f.toStopId, 'From and to stops must differ')
  .refine((f) => !f.validTo || !f.validFrom || f.validTo >= f.validFrom, 'validTo must be on or after validFrom');

router.post('/', ...admin, validate({ body: fareSchema }), async (req, res) => {
  const f = req.valid.body;
  const stops = await one(
    `SELECT a.stop_order AS a, b.stop_order AS b FROM route_stops a, route_stops b
     WHERE a.id = $2 AND b.id = $3 AND a.route_id = $1 AND b.route_id = $1`,
    [f.routeId, f.fromStopId, f.toStopId],
  );
  if (!stops) throw AppError.badRequest('Both stops must belong to the route');
  if (stops.a >= stops.b) throw AppError.badRequest('From stop must come before to stop');

  const fare = await one(
    `INSERT INTO fares (route_id, from_stop_id, to_stop_id, bus_class, amount, valid_from, valid_to)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6::date, CURRENT_DATE), $7) RETURNING *`,
    [f.routeId, f.fromStopId, f.toStopId, f.busClass, f.amount, f.validFrom ?? null, f.validTo ?? null],
  );
  await audit({ req, action: 'fare.create', entityType: 'fare', entityId: fare.id, newData: fare });
  res.status(201).json({ data: fare });
});

router.patch(
  '/:id',
  ...admin,
  validate({
    params: idParam,
    body: z.object({ amount: money, validTo: isoDate.nullable() }).partial().strict(),
  }),
  async (req, res) => {
    const old = await one(`SELECT * FROM fares WHERE id = $1`, [req.valid.params.id]);
    if (!old) throw AppError.notFound('Fare not found');
    const { setSql, values } = buildUpdate(req.valid.body, { amount: 'amount', validTo: 'valid_to' }, 2);
    const fare = await one(`UPDATE fares SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
    await audit({ req, action: 'fare.update', entityType: 'fare', entityId: fare.id, oldData: old, newData: fare });
    res.json({ data: fare });
  },
);

export default router;
