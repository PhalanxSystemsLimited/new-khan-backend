import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { buildUpdate } from '../../utils/sql.js';
import { audit } from '../../utils/audit.js';
import { assertUnused } from '../../utils/safeDelete.js';
import { busClass, idParam, intId, isoDate, text, time } from '../../utils/schemas.js';

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
            rs.minutes_from_origin, rs.stay_minutes, rs.km_from_origin, rs.is_boarding_point, rs.is_dropping_point
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

// minutesFromOrigin: when the bus LEAVES the stop (boarding). stayMinutes: how long it waits there, so it arrives
// stayMinutes earlier (dropping). The first and last stops have no stay.
const stopSchema = z
  .object({
    terminalId: intId,
    minutesFromOrigin: z.number().int().min(0).max(5000),
    stayMinutes: z.number().int().min(0).max(600).default(0),
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
    if (stops[0].stayMinutes || stops[stops.length - 1].stayMinutes) {
      ctx.addIssue({ code: 'custom', message: 'The first and last stops have no stay time' });
    }
    for (let i = 1; i < stops.length; i++) {
      // It must arrive after it left the stop before: a travel time of at least one minute.
      if (stops[i].minutesFromOrigin - stops[i].stayMinutes <= stops[i - 1].minutesFromOrigin) {
        ctx.addIssue({ code: 'custom', message: `Stop ${i + 1}: the travel time from the stop before must be more than 0` });
        break;
      }
    }
  });

async function replaceStops(client, routeId, stops) {
  await client.query(`DELETE FROM route_stops WHERE route_id = $1`, [routeId]);
  for (const [i, s] of stops.entries()) {
    await client.query(
      `INSERT INTO route_stops (route_id, terminal_id, stop_order, minutes_from_origin, stay_minutes, km_from_origin,
                                is_boarding_point, is_dropping_point)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [routeId, s.terminalId, i + 1, s.minutesFromOrigin, s.stayMinutes, s.kmFromOrigin, s.isBoardingPoint, s.isDroppingPoint],
    );
  }
}

// Departure times made into schedules together with a new route (the "Also create schedules" part of the form).
const routeSchedulesSchema = z
  .object({
    times: z.array(time).min(1).max(24).transform((t) => [...new Set(t)].sort()),
    busClass,
    defaultBusId: intId.nullable().optional(),
    daysOfWeek: z.array(z.number().int().min(1).max(7)).min(1).max(7).transform((d) => [...new Set(d)].sort()).optional(),
    effectiveFrom: isoDate.optional(),
  })
  .strict();

const routeSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,20}$/),
    name: text(3, 150),
    distanceKm: z.number().positive().max(5000).optional(),
    stops: stopsArray,
    schedules: routeSchedulesSchema.optional(),
  })
  .strict();

router.post('/', ...admin, validate({ body: routeSchema }), async (req, res) => {
  const b = req.valid.body;
  const last = b.stops[b.stops.length - 1];
  const { route, schedules } = await withTransaction(async (client) => {
    const taken = await one(`SELECT id FROM routes WHERE code = $1`, [b.code], client);
    if (taken) throw AppError.conflict(`Route code ${b.code} is already used. Choose another code.`);
    const r = await one(
      `INSERT INTO routes (code, name, origin_terminal_id, destination_terminal_id, distance_km, est_duration_minutes)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [b.code, b.name, b.stops[0].terminalId, last.terminalId, b.distanceKm ?? null, last.minutesFromOrigin],
      client,
    );
    await replaceStops(client, r.id, b.stops);
    // The route and its schedules are made together: both or neither.
    const made = [];
    for (const t of b.schedules?.times ?? []) {
      const s = b.schedules;
      made.push(
        await one(
          `INSERT INTO schedules (route_id, departure_time, bus_class, default_bus_id, days_of_week, effective_from)
           VALUES ($1, $2, $3, $4, COALESCE($5::smallint[], '{1,2,3,4,5,6,7}'), COALESCE($6::date, CURRENT_DATE))
           RETURNING *`,
          [r.id, t, s.busClass, s.defaultBusId ?? null, s.daysOfWeek ?? null, s.effectiveFrom ?? null],
          client,
        ),
      );
    }
    return { route: await getRouteWithStops(r.id, client), schedules: made };
  });
  await audit({ req, action: 'route.create', entityType: 'route', entityId: route.id, newData: b });
  for (const s of schedules) {
    await audit({ req, action: 'schedule.create', entityType: 'schedule', entityId: s.id, newData: { ...s, madeWithRoute: route.code } });
  }
  res.status(201).json({ data: route, schedules });
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

/**
 * Delete a route nothing uses yet: no trips, schedules, promo codes or report settings. Its own stops and fares go
 * with it (the admin is told how many first). Otherwise: untick Active.
 */
router.delete('/:id', ...admin, validate({ params: idParam }), async (req, res) => {
  const { id } = req.valid.params;
  await withTransaction(async (client) => {
    const r = await one(`SELECT * FROM routes WHERE id = $1 FOR UPDATE`, [id], client);
    if (!r) throw AppError.notFound('Route not found');
    const rules = { what: `Route ${r.code}`, instead: 'Untick "Active" in Edit to stop using it instead.' };
    await assertUnused(client, 'routes', id, { ...rules, skip: ['route_stops', 'fares'] });
    const { rows: stops } = await query(`SELECT * FROM route_stops WHERE route_id = $1 ORDER BY stop_order FOR UPDATE`, [id], client);
    for (const s of stops) await assertUnused(client, 'route_stops', s.id, { ...rules, skip: ['fares'] });
    const { rows: fares } = await query(`SELECT * FROM fares WHERE route_id = $1 ORDER BY id`, [id], client);
    await client.query(`DELETE FROM routes WHERE id = $1`, [id]); // its stops and fares go with it
    await audit({ req, client, action: 'route.delete', entityType: 'route', entityId: id, oldData: { ...r, stops, fares } });
  });
  res.status(204).end();
});

/**
 * Replace the full stop list. Blocked once bookings use the stops. The route's fares belong to its old stops and are
 * deleted with them: the request must say so (deleteFares), so the admin is warned with the count first.
 */
router.put(
  '/:id/stops',
  ...admin,
  validate({
    params: idParam,
    body: z.object({ stops: stopsArray, deleteFares: z.boolean().optional(), confirmTimesChange: z.boolean().optional() }).strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { stops, deleteFares, confirmTimesChange } = req.valid.body;
    let faresDeleted = 0;
    let timesOnly = null; // set when only times, stays, km or Boards/Drops changed: the stops are updated in place
    const route = await withTransaction(async (client) => {
      const exists = await one(`SELECT id FROM routes WHERE id = $1 FOR UPDATE`, [id], client);
      if (!exists) throw AppError.notFound('Route not found');
      const { rows: old } = await query(
        `SELECT id, terminal_id, minutes_from_origin, stay_minutes, km_from_origin, is_boarding_point, is_dropping_point
         FROM route_stops WHERE route_id = $1 ORDER BY stop_order FOR UPDATE`,
        [id],
        client,
      );
      // Same terminals in the same order: update the stops in place. Their fares and bookings stay with them,
      // so this is allowed after bookings exist (booked tickets then show the new times).
      if (old.length === stops.length && old.every((o, i) => o.terminalId === stops[i].terminalId)) {
        const retimed = old.some((o, i) => o.minutesFromOrigin !== stops[i].minutesFromOrigin || o.stayMinutes !== stops[i].stayMinutes);
        const booked = retimed
          ? (await one(
              `SELECT count(*)::int AS n FROM bookings b JOIN trips t ON t.id = b.trip_id
               WHERE t.route_id = $1 AND t.status IN ('scheduled', 'delayed', 'boarding')
                 AND b.status IN ('pending', 'confirmed')`,
              [id],
              client,
            )).n
          : 0;
        if (booked && !confirmTimesChange) {
          throw new AppError(
            409,
            `${booked} booking${booked === 1 ? '' : 's'} on this route's coming trips will show the new times on their tickets. Tell those passengers if a time moves earlier.`,
            'TIMES_CHANGE_BOOKED',
            { bookings: booked },
          );
        }
        for (const [i, s] of stops.entries()) {
          await client.query(
            `UPDATE route_stops SET minutes_from_origin = $2, stay_minutes = $3, km_from_origin = $4,
                    is_boarding_point = $5, is_dropping_point = $6
             WHERE id = $1`,
            [old[i].id, s.minutesFromOrigin, s.stayMinutes, s.kmFromOrigin, s.isBoardingPoint, s.isDroppingPoint],
          );
        }
        const duration = stops[stops.length - 1].minutesFromOrigin;
        await client.query(`UPDATE routes SET est_duration_minutes = $2 WHERE id = $1`, [id, duration]);
        // Trips not yet gone arrive at the new time (used when checking a bus is free).
        const moved = await query(
          `UPDATE trips SET arrival_at = departure_at + make_interval(mins => $2)
           WHERE route_id = $1 AND status IN ('scheduled', 'delayed', 'boarding')
             AND arrival_at IS DISTINCT FROM departure_at + make_interval(mins => $2)`,
          [id, duration],
          client,
        );
        timesOnly = { old, bookingsShowingNewTimes: booked, tripsRetimed: moved.rowCount ?? 0 };
        return getRouteWithStops(id, client);
      }
      const used = await one(
        `SELECT EXISTS (SELECT 1 FROM bookings b JOIN route_stops rs ON rs.id = b.boarding_stop_id WHERE rs.route_id = $1) AS used`,
        [id],
        client,
      );
      if (used.used) throw AppError.conflict('Stops cannot be replaced after bookings exist. Create a new route instead.');
      faresDeleted = (await one(`SELECT count(*)::int AS n FROM fares WHERE route_id = $1`, [id], client)).n;
      if (faresDeleted && !deleteFares) {
        throw new AppError(
          409,
          `Saving these stops deletes this route's ${faresDeleted} fare${faresDeleted === 1 ? '' : 's'}: fares belong to the old stops. Set the fares again after saving.`,
          'FARES_WOULD_BE_DELETED',
          { fares: faresDeleted },
        );
      }
      await replaceStops(client, id, stops);
      await client.query(
        `UPDATE routes SET origin_terminal_id = $2, destination_terminal_id = $3, est_duration_minutes = $4 WHERE id = $1`,
        [id, stops[0].terminalId, stops[stops.length - 1].terminalId, stops[stops.length - 1].minutesFromOrigin],
      );
      return getRouteWithStops(id, client);
    });
    if (timesOnly) {
      const { old, ...counts } = timesOnly;
      await audit({ req, action: 'route.stops_update', entityType: 'route', entityId: id, oldData: { stops: old }, newData: { stops, ...counts } });
    } else {
      await audit({ req, action: 'route.stops_replace', entityType: 'route', entityId: id, newData: { stops, faresDeleted } });
    }
    res.json({ data: route, inPlace: Boolean(timesOnly) });
  },
);

export default router;
