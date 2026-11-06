import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { buildUpdate } from '../../utils/sql.js';
import { audit } from '../../utils/audit.js';
import { idParam, intId, text } from '../../utils/schemas.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];

export async function getRouteWithStops(id, client) {
  const route = await one(
    `SELECT r.*, ot.name AS origin_terminal, dt.name AS destination_terminal
     FROM routes r
     JOIN terminals ot ON ot.id = r.origin_terminal_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id
     WHERE r.id = $1`,
    [id],
    client,
  );
  if (!route) return null;
  const { rows: stops } = await query(
    `SELECT rs.id, rs.terminal_id, t.name AS terminal_name, c.name AS city_name, rs.stop_order,
            rs.minutes_from_origin, rs.km_from_origin, rs.is_boarding_point, rs.is_dropping_point
     FROM route_stops rs
     JOIN terminals t ON t.id = rs.terminal_id
     JOIN cities c ON c.id = t.city_id
     WHERE rs.route_id = $1 ORDER BY rs.stop_order`,
    [id],
    client,
  );
  return { ...route, stops };
}

router.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.code, r.name, r.distance_km, r.est_duration_minutes,
            oc.name AS origin_city, dc.name AS destination_city
     FROM routes r
     JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id JOIN cities dc ON dc.id = dt.city_id
     WHERE r.is_active ORDER BY r.name`,
  );
  res.json({ data: rows });
});

router.get('/:id', validate({ params: idParam }), async (req, res) => {
  const route = await getRouteWithStops(req.valid.params.id);
  if (!route || !route.isActive) throw AppError.notFound('Route not found');
  res.json({ data: route });
});

const stopSchema = z
  .object({
    terminalId: intId,
    minutesFromOrigin: z.number().int().min(0).max(5000),
    kmFromOrigin: z.number().min(0).max(5000).default(0),
    isBoardingPoint: z.boolean().default(true),
    isDroppingPoint: z.boolean().default(true),
  })
  .strict();

const stopsArray = z
  .array(stopSchema)
  .min(2, 'A route needs at least an origin and a destination stop')
  .max(30)
  .superRefine((stops, ctx) => {
    const ids = new Set(stops.map((s) => s.terminalId));
    if (ids.size !== stops.length) ctx.addIssue({ code: 'custom', message: 'A terminal can appear only once per route' });
    if (stops[0].minutesFromOrigin !== 0) ctx.addIssue({ code: 'custom', message: 'First stop must have minutesFromOrigin = 0' });
    for (let i = 1; i < stops.length; i++) {
      if (stops[i].minutesFromOrigin <= stops[i - 1].minutesFromOrigin) {
        ctx.addIssue({ code: 'custom', message: 'Stops must be in travel order with increasing minutesFromOrigin' });
        break;
      }
    }
  });

async function replaceStops(client, routeId, stops) {
  await client.query(`DELETE FROM route_stops WHERE route_id = $1`, [routeId]);
  for (const [i, s] of stops.entries()) {
    await client.query(
      `INSERT INTO route_stops (route_id, terminal_id, stop_order, minutes_from_origin, km_from_origin,
                                is_boarding_point, is_dropping_point)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [routeId, s.terminalId, i + 1, s.minutesFromOrigin, s.kmFromOrigin, s.isBoardingPoint, s.isDroppingPoint],
    );
  }
}

const routeSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
    name: text(3, 150),
    distanceKm: z.number().positive().max(5000).optional(),
    stops: stopsArray,
  })
  .strict();

router.post('/', ...admin, validate({ body: routeSchema }), async (req, res) => {
  const b = req.valid.body;
  const last = b.stops[b.stops.length - 1];
  const route = await withTransaction(async (client) => {
    const r = await one(
      `INSERT INTO routes (code, name, origin_terminal_id, destination_terminal_id, distance_km, est_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.code, b.name, b.stops[0].terminalId, last.terminalId, b.distanceKm ?? null, last.minutesFromOrigin],
      client,
    );
    await replaceStops(client, r.id, b.stops);
    return getRouteWithStops(r.id, client);
  });
  await audit({ req, action: 'route.create', entityType: 'route', entityId: route.id, newData: b });
  res.status(201).json({ data: route });
});

router.patch(
  '/:id',
  ...admin,
  validate({
    params: idParam,
    body: z
      .object({ name: text(3, 150), distanceKm: z.number().positive().max(5000), isActive: z.boolean() })
      .partial()
      .strict(),
  }),
  async (req, res) => {
    const { setSql, values } = buildUpdate(
      req.valid.body,
      { name: 'name', distanceKm: 'distance_km', isActive: 'is_active' },
      2,
    );
    const r = await one(`UPDATE routes SET ${setSql} WHERE id = $1 RETURNING id`, [req.valid.params.id, ...values]);
    if (!r) throw AppError.notFound('Route not found');
    res.json({ data: await getRouteWithStops(r.id) });
  },
);

/** Replace the full stop list. Blocked once bookings or fares reference the stops. */
router.put(
  '/:id/stops',
  ...admin,
  validate({ params: idParam, body: z.object({ stops: stopsArray }).strict() }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { stops } = req.valid.body;
    const route = await withTransaction(async (client) => {
      const exists = await one(`SELECT id FROM routes WHERE id = $1 FOR UPDATE`, [id], client);
      if (!exists) throw AppError.notFound('Route not found');
      const used = await one(
        `SELECT EXISTS (SELECT 1 FROM bookings b JOIN route_stops rs ON rs.id = b.boarding_stop_id WHERE rs.route_id = $1) AS used`,
        [id],
        client,
      );
      if (used.used) throw AppError.conflict('Stops cannot be replaced after bookings exist. Create a new route instead.');
      await replaceStops(client, id, stops);
      await client.query(
        `UPDATE routes SET origin_terminal_id = $2, destination_terminal_id = $3, est_duration_minutes = $4 WHERE id = $1`,
        [id, stops[0].terminalId, stops[stops.length - 1].terminalId, stops[stops.length - 1].minutesFromOrigin],
      );
      return getRouteWithStops(id, client);
    });
    await audit({ req, action: 'route.stops_replace', entityType: 'route', entityId: id, newData: { stops } });
    res.json({ data: route });
  },
);

export default router;
