import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { buildUpdate } from '../../utils/sql.js';
import { audit } from '../../utils/audit.js';
import { busClass, idParam, intId, isoDate, time } from '../../utils/schemas.js';
import { busConfirmReady } from '../trips/busConfirm.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];
const staff = [requireAuth, requireRole(...STAFF_ROLES)];

const daysOfWeek = z
  .array(z.number().int().min(1).max(7))
  .min(1)
  .max(7)
  .transform((d) => [...new Set(d)].sort());

const scheduleSchema = z
  .object({
    routeId: intId,
    departureTime: time,
    busClass,
    defaultBusId: intId.nullable().optional(),
    daysOfWeek: daysOfWeek.optional(),
    effectiveFrom: isoDate.optional(),
    effectiveTo: isoDate.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const COLS = {
  departureTime: 'departure_time',
  busClass: 'bus_class',
  defaultBusId: 'default_bus_id',
  daysOfWeek: 'days_of_week',
  effectiveFrom: 'effective_from',
  effectiveTo: 'effective_to',
  isActive: 'is_active',
};

router.get('/', ...staff, validate({ query: z.object({ routeId: intId.optional() }).strict() }), async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, r.name AS route_name, b.registration_no AS default_bus
     FROM schedules s JOIN routes r ON r.id = s.route_id LEFT JOIN buses b ON b.id = s.default_bus_id
     WHERE ($1::int IS NULL OR s.route_id = $1)
     ORDER BY r.name, s.departure_time`,
    [req.valid.query.routeId ?? null],
  );
  res.json({ data: rows });
});

router.post('/', ...admin, validate({ body: scheduleSchema }), async (req, res) => {
  const s = req.valid.body;
  const schedule = await one(
    `INSERT INTO schedules (route_id, departure_time, bus_class, default_bus_id, days_of_week,
                            effective_from, effective_to, is_active)
     VALUES ($1, $2, $3, $4, COALESCE($5::smallint[], '{1,2,3,4,5,6,7}'), COALESCE($6::date, CURRENT_DATE), $7, COALESCE($8, TRUE))
     RETURNING *`,
    [s.routeId, s.departureTime, s.busClass, s.defaultBusId ?? null, s.daysOfWeek ?? null,
      s.effectiveFrom ?? null, s.effectiveTo ?? null, s.isActive ?? null],
  );
  res.status(201).json({ data: schedule });
});

router.patch(
  '/:id',
  ...admin,
  validate({ params: idParam, body: scheduleSchema.omit({ routeId: true }).partial() }),
  async (req, res) => {
    const { setSql, values } = buildUpdate(req.valid.body, COLS, 2);
    const s = await one(`UPDATE schedules SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
    if (!s) throw AppError.notFound('Schedule not found');
    res.json({ data: s });
  },
);

/**
 * Create dated trips from a schedule for a date range (max 92 days).
 * Existing trips for the same schedule/time are skipped, so this is safe to re-run.
 * Days when the default bus is already on another trip are skipped and listed in `skipped`.
 */
router.post(
  '/:id/generate-trips',
  ...admin,
  validate({
    params: idParam,
    body: z
      .object({
        fromDate: isoDate,
        toDate: isoDate,
        bookingCloseMinutes: z.number().int().min(0).max(720).default(30),
      })
      .strict()
      .refine((b) => b.toDate >= b.fromDate, 'toDate must be on or after fromDate')
      .refine(
        (b) => (Date.parse(b.toDate) - Date.parse(b.fromDate)) / 86_400_000 <= 92,
        'Range can be at most 92 days',
      ),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { fromDate, toDate, bookingCloseMinutes } = req.valid.body;

    const result = await withTransaction((client) => generateTrips(client, id, fromDate, toDate, bookingCloseMinutes));
    await audit({
      req, action: 'schedule.generate_trips', entityType: 'schedule', entityId: id,
      newData: {
        fromDate, toDate, created: result.created, alreadyThere: result.alreadyThere, busToConfirm: result.busToConfirm,
        skippedBusBusy: result.skipped.map((s) => s.date),
      },
    });
    res.status(201).json({ data: result });
  },
);

/**
 * The work behind "Create trips". Each running day in the range is one of:
 *  - already there (this schedule already has that trip): left alone;
 *  - created.
 * Tickets are sold on the departure, not the bus (busConfirm.js): every trip is created with the default bus as its
 * PLANNED bus (seat type and class only) and the bus is confirmed at departure time, so no day is skipped.
 *
 * Before migration 2026-11-22 (no bus_confirmed column) it works as it used to: a day when the default bus is busy
 * (on another trip that overlaps) is skipped and reported, so staff can add that day with another bus.
 */
export async function generateTrips(client, id, fromDate, toDate, bookingCloseMinutes) {
  const planned = await busConfirmReady(client);
  const sched = await one(
    `SELECT s.id, s.default_bus_id, s.is_active, r.est_duration_minutes
     FROM schedules s JOIN routes r ON r.id = s.route_id WHERE s.id = $1`,
    [id],
    client,
  );
  if (!sched) throw AppError.notFound('Schedule not found');
  if (!sched.isActive) throw AppError.unprocessable('Schedule is inactive');
  if (!sched.defaultBusId) throw AppError.unprocessable('Assign a default bus to the schedule first');
  if (!sched.estDurationMinutes) throw AppError.unprocessable('Route has no estimated duration');

  // Lock the bus so two "Create trips" runs for the same bus can't both see it free.
  const bus = await one('SELECT id, registration_no, is_active FROM buses WHERE id = $1 FOR UPDATE', [sched.defaultBusId], client);
  if (!bus?.isActive) throw AppError.unprocessable(`The default bus${bus ? ` ${bus.registrationNo}` : ''} is inactive. Choose another bus for the schedule first.`);

  const { rows: days } = await query(
    `WITH cand AS (
       SELECT g.d::date AS day, x.dep, x.dep + make_interval(mins => r.est_duration_minutes) AS arr
       FROM schedules s
       JOIN routes r ON r.id = s.route_id
       CROSS JOIN LATERAL generate_series($2::date, $3::date, interval '1 day') AS g(d)
       CROSS JOIN LATERAL (SELECT (g.d::date + s.departure_time) AT TIME ZONE 'Asia/Karachi' AS dep) x
       WHERE s.id = $1
         AND extract(isodow FROM g.d)::smallint = ANY (s.days_of_week)
         AND g.d::date >= s.effective_from
         AND (s.effective_to IS NULL OR g.d::date <= s.effective_to)
         AND x.dep > now()
     )
     SELECT to_char(c.day, 'YYYY-MM-DD') AS day, c.dep, c.arr,
            EXISTS (SELECT 1 FROM trips t WHERE t.schedule_id = $1 AND t.departure_at = c.dep) AS already_there,
            k.id AS clash_trip_id, k.route_name AS clash_route, k.departure_at AS clash_departure_at
     FROM cand c
     LEFT JOIN LATERAL (
       SELECT t.id, rr.name AS route_name, t.departure_at
       FROM trips t JOIN routes rr ON rr.id = t.route_id
       WHERE t.bus_id = $4 AND t.status NOT IN ('cancelled', 'arrived')
         AND tstzrange(t.departure_at, t.arrival_at) && tstzrange(c.dep, c.arr)
       ORDER BY t.departure_at LIMIT 1
     ) k ON TRUE
     ORDER BY c.dep`,
    [id, fromDate, toDate, sched.defaultBusId],
    client,
  );

  const toCreate = [];
  const skipped = [];
  let alreadyThere = 0;
  let lastArr = null; // a route longer than a day would make this run's own trips overlap
  for (const d of days) {
    if (d.alreadyThere) { alreadyThere += 1; continue; }
    if (planned) { toCreate.push(d.dep); continue; } // the bus is confirmed later: nothing to skip
    if (d.clashTripId) {
      skipped.push({ date: d.day, departureAt: d.dep, clashTripId: d.clashTripId, clashRoute: d.clashRoute, clashDepartureAt: d.clashDepartureAt });
      continue;
    }
    if (lastArr && new Date(d.dep) < lastArr) {
      skipped.push({ date: d.day, departureAt: d.dep, clashTripId: null, clashRoute: null, clashDepartureAt: null });
      continue;
    }
    toCreate.push(d.dep);
    lastArr = new Date(d.arr);
  }

  let trips = [];
  if (toCreate.length) {
    ({ rows: trips } = await query(
      `INSERT INTO trips (schedule_id, route_id, bus_id, departure_at, arrival_at, booking_closes_at${planned ? ', bus_confirmed' : ''})
       SELECT s.id, s.route_id, s.default_bus_id, d.dep,
              d.dep + make_interval(mins => r.est_duration_minutes),
              d.dep - make_interval(mins => $3)${planned ? ', FALSE' : ''}
       FROM schedules s JOIN routes r ON r.id = s.route_id
       CROSS JOIN unnest($2::timestamptz[]) AS d(dep)
       WHERE s.id = $1
       ON CONFLICT (schedule_id, departure_at) WHERE schedule_id IS NOT NULL DO NOTHING
       RETURNING id, departure_at`,
      [id, toCreate, bookingCloseMinutes],
      client,
    ));
  }
  return { created: trips.length, trips, alreadyThere, bus: bus.registrationNo, skipped, busToConfirm: planned };
}

export default router;
