import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { buildUpdate } from '../../utils/sql.js';
import { audit } from '../../utils/audit.js';
import { busClass, idParam, intId, isoDate, time } from '../../utils/schemas.js';

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

    const sched = await one(
      `SELECT s.id, s.default_bus_id, s.is_active, r.est_duration_minutes
       FROM schedules s JOIN routes r ON r.id = s.route_id WHERE s.id = $1`,
      [id],
    );
    if (!sched) throw AppError.notFound('Schedule not found');
    if (!sched.isActive) throw AppError.unprocessable('Schedule is inactive');
    if (!sched.defaultBusId) throw AppError.unprocessable('Assign a default bus to the schedule first');
    if (!sched.estDurationMinutes) throw AppError.unprocessable('Route has no estimated duration');

    const { rows } = await query(
      `INSERT INTO trips (schedule_id, route_id, bus_id, departure_at, arrival_at, booking_closes_at)
       SELECT s.id, s.route_id, s.default_bus_id, x.dep,
              x.dep + make_interval(mins => r.est_duration_minutes),
              x.dep - make_interval(mins => $4)
       FROM schedules s
       JOIN routes r ON r.id = s.route_id
       CROSS JOIN LATERAL generate_series($2::date, $3::date, interval '1 day') AS g(d)
       CROSS JOIN LATERAL (SELECT (g.d::date + s.departure_time) AT TIME ZONE 'Asia/Karachi' AS dep) x
       WHERE s.id = $1
         AND extract(isodow FROM g.d)::smallint = ANY (s.days_of_week)
         AND g.d::date >= s.effective_from
         AND (s.effective_to IS NULL OR g.d::date <= s.effective_to)
         AND x.dep > now()
       ON CONFLICT (schedule_id, departure_at) WHERE schedule_id IS NOT NULL DO NOTHING
       RETURNING id, departure_at`,
      [id, fromDate, toDate, bookingCloseMinutes],
    );
    await audit({ req, action: 'schedule.generate_trips', entityType: 'schedule', entityId: id, newData: { fromDate, toDate, created: rows.length } });
    res.status(201).json({ data: { created: rows.length, trips: rows } });
  },
);

export default router;
