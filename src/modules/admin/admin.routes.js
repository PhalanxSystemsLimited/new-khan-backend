import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { buildUpdate, offsetOf, paged } from '../../utils/sql.js';
import {
  bigIdParam, idParam, intId, isoDate, isoDateTime, longText, money, pagination, text, uuidParam,
} from '../../utils/schemas.js';
import { getRouteWithStops } from '../routes/routes.routes.js';
import { markPaymentRefunded } from '../bookings/bookings.service.js';
import { assertUnused } from '../../utils/safeDelete.js';

const router = Router();
/** Admins: everything here. Managers: only reading refunds and reports. */
const MANAGER_READABLE = [/^\/refunds\/?$/, /^\/reports\//];
router.use(requireAuth, (req, _res, next) => {
  if (ADMIN_ROLES.includes(req.user.role)) return next();
  if (req.user.role === 'manager' && req.method === 'GET' && MANAGER_READABLE.some((r) => r.test(req.path))) return next();
  throw AppError.forbidden();
});

// ======================= Lists for the admin panel (include inactive rows) =======================
router.get('/routes', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.code, r.name, r.distance_km, r.est_duration_minutes, r.is_active,
            ot.name AS origin_terminal, dt.name AS destination_terminal,
            ot.city_id AS origin_city_id, dt.city_id AS destination_city_id,
            oc.name AS origin_city, dc.name AS destination_city,
            (SELECT count(*) FROM route_stops rs WHERE rs.route_id = r.id)::int AS stop_count
     FROM routes r
     JOIN terminals ot ON ot.id = r.origin_terminal_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id
     JOIN cities oc ON oc.id = ot.city_id
     JOIN cities dc ON dc.id = dt.city_id
     ORDER BY r.is_active DESC, r.name`,
  );
  res.json({ data: rows });
});

/**
 * For "Choose locations" in New schedule and One-off trip: every route's stops in order (terminal, minutes from the
 * first stop). The form uses it to fill in known travel times and to say when the chosen stops are a saved route.
 */
router.get('/route-builder', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.name, r.is_active,
            (SELECT json_agg(json_build_object('terminalId', rs.terminal_id, 'minutes', rs.minutes_from_origin) ORDER BY rs.stop_order)
             FROM route_stops rs WHERE rs.route_id = r.id) AS stops
     FROM routes r ORDER BY r.is_active DESC, r.id`,
  );
  res.json({ data: rows.map((r) => ({ ...r, stops: r.stops ?? [] })) });
});

router.get('/routes/:id', validate({ params: idParam }), async (req, res) => {
  const route = await getRouteWithStops(req.valid.params.id);
  if (!route) throw AppError.notFound('Route not found');
  res.json({ data: route });
});

router.get('/locations', async (_req, res) => {
  const cities = await query(`SELECT id, name, province, country, is_active FROM cities ORDER BY name`);
  const terminals = await query(
    `SELECT t.id, t.city_id, c.name AS city_name, t.name, t.code, t.address, t.phone, t.latitude, t.longitude, t.is_active, t.is_origin
     FROM terminals t JOIN cities c ON c.id = t.city_id ORDER BY c.name, t.name`,
  );
  res.json({ data: { cities: cities.rows, terminals: terminals.rows } });
});

// ======================= Promo codes =======================
const promoSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/),
    description: longText(500).optional(),
    discountType: z.enum(['percentage', 'fixed']),
    discountValue: z.number().positive().max(1_000_000),
    maxDiscount: money.optional(),
    minBookingAmount: money.default(0),
    usageLimit: z.number().int().positive().optional(),
    perUserLimit: z.number().int().positive().max(100).default(1),
    validFrom: isoDateTime.optional(),
    validTo: isoDateTime,
    routeId: intId.optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

router.get('/promo-codes', validate({ query: pagination.strict() }), async (req, res) => {
  const q = req.valid.query;
  const total = (await one(`SELECT count(*)::int AS n FROM promo_codes`)).n;
  const { rows } = await query(`SELECT * FROM promo_codes ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [q.limit, offsetOf(q)]);
  res.json(paged(rows, q, total));
});

router.post(
  '/promo-codes',
  validate({
    body: promoSchema
      .refine((p) => p.discountType !== 'percentage' || p.discountValue <= 100, 'Percentage cannot exceed 100')
      .refine((p) => !p.validFrom || p.validTo > p.validFrom, 'validTo must be after validFrom'),
  }),
  async (req, res) => {
    const p = req.valid.body;
    const promo = await one(
      `INSERT INTO promo_codes (code, description, discount_type, discount_value, max_discount, min_booking_amount,
                                usage_limit, per_user_limit, valid_from, valid_to, route_id, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10, $11, COALESCE($12, TRUE)) RETURNING *`,
      [p.code, p.description ?? null, p.discountType, p.discountValue, p.maxDiscount ?? null, p.minBookingAmount,
        p.usageLimit ?? null, p.perUserLimit, p.validFrom ?? null, p.validTo, p.routeId ?? null, p.isActive ?? null],
    );
    await audit({ req, action: 'promo.create', entityType: 'promo_code', entityId: promo.id, newData: promo });
    res.status(201).json({ data: promo });
  },
);

router.patch(
  '/promo-codes/:id',
  validate({
    params: idParam,
    body: promoSchema.pick({ description: true, maxDiscount: true, usageLimit: true, validTo: true, isActive: true }).partial(),
  }),
  async (req, res) => {
    const { setSql, values } = buildUpdate(
      req.valid.body,
      { description: 'description', maxDiscount: 'max_discount', usageLimit: 'usage_limit', validTo: 'valid_to', isActive: 'is_active' },
      2,
    );
    const promo = await one(`UPDATE promo_codes SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
    if (!promo) throw AppError.notFound('Promo code not found');
    res.json({ data: promo });
  },
);

/** Only a code never used on a booking (not even a hold). Otherwise: untick Active. */
router.delete('/promo-codes/:id', validate({ params: idParam }), async (req, res) => {
  await withTransaction(async (client) => {
    const p = await one(`SELECT * FROM promo_codes WHERE id = $1 FOR UPDATE`, [req.valid.params.id], client);
    if (!p) throw AppError.notFound('Promo code not found');
    await assertUnused(client, 'promo_codes', p.id, { what: `Code ${p.code}`, instead: 'Untick "Active" in Edit to stop it being used instead.' });
    await client.query(`DELETE FROM promo_codes WHERE id = $1`, [p.id]);
    await audit({ req, client, action: 'promo.delete', entityType: 'promo_code', entityId: p.id, oldData: p });
  });
  res.status(204).end();
});

// ======================= Cancellation policies =======================
router.get('/cancellation-policies', async (_req, res) => {
  const { rows } = await query(`SELECT * FROM cancellation_policies ORDER BY min_hours_before DESC`);
  res.json({ data: rows });
});

router.put(
  '/cancellation-policies',
  validate({
    body: z
      .object({
        policies: z
          .array(
            z.object({
              name: text(2, 80),
              minHoursBefore: z.number().int().min(0).max(720),
              refundPercent: z.number().min(0).max(100),
            }).strict(),
          )
          .min(1)
          .max(20)
          .refine((p) => new Set(p.map((x) => x.minHoursBefore)).size === p.length, 'minHoursBefore values must be unique')
          .refine((p) => p.some((x) => x.minHoursBefore === 0), 'Include a rule with minHoursBefore = 0'),
      })
      .strict(),
  }),
  async (req, res) => {
    const rows = await withTransaction(async (client) => {
      await client.query(`DELETE FROM cancellation_policies`);
      for (const p of req.valid.body.policies) {
        await client.query(
          `INSERT INTO cancellation_policies (name, min_hours_before, refund_percent) VALUES ($1, $2, $3)`,
          [p.name, p.minHoursBefore, p.refundPercent],
        );
      }
      return (await query(`SELECT * FROM cancellation_policies ORDER BY min_hours_before DESC`, [], client)).rows;
    });
    await audit({ req, action: 'cancellation_policy.replace', entityType: 'cancellation_policy', entityId: 'all', newData: req.valid.body });
    res.json({ data: rows });
  },
);

// ======================= Refunds =======================
router.get(
  '/refunds',
  validate({
    query: pagination.extend({ status: z.enum(['requested', 'approved', 'processed', 'rejected']).optional() }).strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const total = (await one(`SELECT count(*)::int AS n FROM refunds WHERE ($1::refund_status IS NULL OR status = $1)`, [q.status ?? null])).n;
    const { rows } = await query(
      `SELECT rf.*, bk.pnr, bk.contact_name, bk.contact_phone, p.method AS payment_method, pu.full_name AS processed_by_name
       FROM refunds rf JOIN bookings bk ON bk.id = rf.booking_id JOIN payments p ON p.id = rf.payment_id
       LEFT JOIN users pu ON pu.id = rf.processed_by
       WHERE ($1::refund_status IS NULL OR rf.status = $1)
       ORDER BY rf.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.limit, offsetOf(q)],
    );
    res.json(paged(rows, q, total));
  },
);

const REFUND_TRANSITIONS = { requested: ['approved', 'rejected'], approved: ['processed', 'rejected'], processed: [], rejected: [] };

/**
 * Online refunds are decided by a super admin only: approve or reject the amount the cancellation rules worked
 * out (it cannot be changed), then mark it paid once it has been sent back. Counter cash refunds never come here:
 * they are paid and recorded at the counter (POST /bookings/:id/counter-cancel).
 */
router.patch(
  '/refunds/:id',
  requireRole('super_admin'),
  validate({
    params: uuidParam,
    body: z
      .object({
        status: z.enum(['approved', 'processed', 'rejected']),
        gatewayRefundId: z.string().trim().max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
        reason: longText(500).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const b = req.valid.body;
    const refund = await withTransaction(async (client) => {
      const rf = await one(`SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [id], client);
      if (!rf) throw AppError.notFound('Refund not found');
      if (!REFUND_TRANSITIONS[rf.status].includes(b.status)) {
        throw AppError.conflict(`Cannot change refund from ${rf.status} to ${b.status}`);
      }
      const updated = await one(
        // $2 is typed explicitly: it is used twice, and Postgres cannot infer one type for it otherwise (42P08).
        `UPDATE refunds SET status = $2::refund_status, gateway_refund_id = COALESCE($3, gateway_refund_id),
                reason = COALESCE($4, reason), processed_by = $5,
                processed_at = CASE WHEN $2::refund_status = 'processed' THEN now() ELSE processed_at END
         WHERE id = $1 RETURNING *`,
        [id, b.status, b.gatewayRefundId ?? null, b.reason ?? null, req.user.id],
        client,
      );
      if (b.status === 'processed') await markPaymentRefunded(client, rf.paymentId);
      return updated;
    });
    await audit({ req, action: 'refund.update', entityType: 'refund', entityId: id, newData: b });
    res.json({ data: refund });
  },
);

// ======================= Reports =======================
const rangeSchema = z
  .object({ from: isoDate, to: isoDate })
  .strict()
  .refine((r) => r.to >= r.from, 'to must be on or after from')
  .refine((r) => (Date.parse(r.to) - Date.parse(r.from)) / 86_400_000 <= 366, 'Range can be at most one year');

router.get('/reports/daily-revenue', validate({ query: rangeSchema }), async (req, res) => {
  const { rows } = await query(
    `SELECT day, method, payments, gross_amount FROM v_daily_revenue
     WHERE day BETWEEN $1::date AND $2::date ORDER BY day, method`,
    [req.valid.query.from, req.valid.query.to],
  );
  res.json({ data: rows });
});

router.get('/reports/summary', validate({ query: rangeSchema }), async (req, res) => {
  const { from, to } = req.valid.query;
  const summary = await one(
    `SELECT
       (SELECT count(*) FROM bookings WHERE status IN ('confirmed','completed')
          AND (created_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2)::int AS confirmed_bookings,
       (SELECT count(*) FROM tickets tk JOIN bookings bk ON bk.id = tk.booking_id
          WHERE bk.status IN ('confirmed','completed') AND tk.status <> 'cancelled'
          AND (bk.created_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2)::int AS seats_sold,
       (SELECT COALESCE(sum(amount), 0) FROM payments WHERE status IN ('succeeded','partially_refunded','refunded')
          AND (paid_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2) AS gross_revenue,
       (SELECT COALESCE(sum(amount), 0) FROM refunds WHERE status = 'processed'
          AND (processed_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2) AS refunds_paid,
       (SELECT count(*) FROM bookings WHERE status = 'cancelled'
          AND (cancelled_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2)::int AS cancellations`,
    [from, to],
  );
  res.json({ data: summary });
});

/**
 * Cash report: per day (Pakistan time) and per staff member, every kind of cash that person took and paid back:
 *   - tickets: cash for counter sales and road passengers (payments), less cash refunds they paid out. A refund counts
 *     for whoever recorded it as paid: counter refunds (the clerk), and refunds of CASH tickets marked paid later
 *     (a cancelled trip's cash tickets), which used to be missing because they are not "counter" refunds;
 *   - extra load: the load slips they wrote (counter and conductor), cancelled slips left out;
 *   - cargo: parcels paid at booking (cancelled ones left out) and receiver-pays parcels they collected for at hand-over.
 * Net is everything that person should be able to account for that day.
 */
router.get('/reports/cash', validate({ query: rangeSchema }), async (req, res) => {
  const { from, to } = req.valid.query;
  const day = (col) => `(${col} AT TIME ZONE 'Asia/Karachi')::date`;
  const between = (col) => `${day(col)} BETWEEN $1 AND $2`;
  // A table from a migration that has not been run yet: that kind of cash is simply left out.
  const optional = (sql) => query(sql, [from, to]).catch((err) => {
    if (['42P01', '42703'].includes(err.code)) return { rows: [] };
    throw err;
  });
  const [tickets, refunds, load, cargoPaid, cargoCollected] = await Promise.all([
    query(
      `SELECT ${day('paid_at')} AS day, received_by AS staff_id, count(*)::int AS n, sum(amount) AS amount
       FROM payments
       WHERE method = 'cash' AND paid_at IS NOT NULL AND status IN ('succeeded', 'refunded', 'partially_refunded') AND ${between('paid_at')}
       GROUP BY 1, 2`,
      [from, to],
    ),
    query(
      `SELECT ${day('rf.processed_at')} AS day, rf.processed_by AS staff_id, count(*)::int AS n, sum(rf.amount) AS amount
       FROM refunds rf JOIN payments p ON p.id = rf.payment_id
       WHERE rf.status = 'processed' AND (rf.channel = 'counter' OR p.method = 'cash') AND ${between('rf.processed_at')}
       GROUP BY 1, 2`,
      [from, to],
    ),
    optional(
      `SELECT ${day('created_at')} AS day, created_by AS staff_id, count(*)::int AS n, sum(amount) AS amount
       FROM load_slips WHERE status = 'active' AND ${between('created_at')} GROUP BY 1, 2`,
    ),
    optional(
      `SELECT ${day('paid_at')} AS day, booked_by AS staff_id, count(*)::int AS n, sum(charge) AS amount
       FROM parcels WHERE payment = 'paid' AND status <> 'cancelled' AND ${between('paid_at')} GROUP BY 1, 2`,
    ),
    optional(
      `SELECT ${day('paid_at')} AS day, delivered_by AS staff_id, count(*)::int AS n, sum(charge) AS amount
       FROM parcels WHERE payment = 'to_pay' AND paid_at IS NOT NULL AND status <> 'cancelled' AND ${between('paid_at')} GROUP BY 1, 2`,
    ),
  ]);

  const byKey = new Map();
  const rowFor = (r) => {
    const d = typeof r.day === 'string' ? r.day.slice(0, 10) : new Date(r.day).toISOString().slice(0, 10);
    const key = `${d}|${r.staffId ?? ''}`;
    if (!byKey.has(key)) {
      byKey.set(key, { day: d, staffId: r.staffId ?? null, sales: 0, taken: 0, refunds: 0, paidOut: 0, loadSlips: 0, loadCash: 0, parcels: 0, cargoCash: 0 });
    }
    return byKey.get(key);
  };
  for (const r of tickets.rows) Object.assign(rowFor(r), { sales: r.n, taken: Number(r.amount) });
  for (const r of refunds.rows) Object.assign(rowFor(r), { refunds: r.n, paidOut: Number(r.amount) });
  for (const r of load.rows) Object.assign(rowFor(r), { loadSlips: r.n, loadCash: Number(r.amount) });
  for (const r of [...cargoPaid.rows, ...cargoCollected.rows]) {
    const x = rowFor(r);
    x.parcels += r.n;
    x.cargoCash += Number(r.amount);
  }

  const ids = [...new Set([...byKey.values()].map((r) => r.staffId).filter(Boolean))];
  const { rows: people } = ids.length
    ? await query(`SELECT id, full_name, email, role FROM users WHERE id = ANY ($1::uuid[])`, [ids])
    : { rows: [] };
  const who = new Map(people.map((u) => [u.id, u]));
  const data = [...byKey.values()]
    .map((r) => {
      const u = who.get(r.staffId);
      return {
        ...r,
        staffName: u?.fullName ?? null,
        staffEmail: u?.email ?? null,
        staffRole: u?.role ?? null,
        // Tickets only, as before; and everything together.
        ticketNet: r.taken - r.paidOut,
        net: r.taken - r.paidOut + r.loadCash + r.cargoCash,
      };
    })
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : String(a.staffName ?? '~').localeCompare(String(b.staffName ?? '~'))));
  res.json({ data });
});

// ======================= Activity log =======================
/** A readable name for the changed item (booking PNR, employee code, voucher number...); NULL when there is none. */
const AUDIT_ITEM_LABEL = `CASE a.entity_type
    WHEN 'booking' THEN (SELECT 'Booking ' || b.pnr FROM bookings b WHERE b.id::text = a.entity_id)
    WHEN 'ticket' THEN (SELECT 'Ticket ' || COALESCE(tk.ticket_no::text, '') || ' · booking ' || b.pnr FROM tickets tk JOIN bookings b ON b.id = tk.booking_id WHERE tk.id::text = a.entity_id)
    WHEN 'payment' THEN (SELECT 'Payment · booking ' || b.pnr FROM payments p JOIN bookings b ON b.id = p.booking_id WHERE p.id::text = a.entity_id)
    WHEN 'refund' THEN (SELECT 'Refund · booking ' || b.pnr FROM refunds rf JOIN bookings b ON b.id = rf.booking_id WHERE rf.id::text = a.entity_id)
    WHEN 'trip' THEN (SELECT r.name || ' · ' || to_char(t.departure_at AT TIME ZONE 'Asia/Karachi', 'DD Mon YYYY, HH12:MI AM') FROM trips t JOIN routes r ON r.id = t.route_id WHERE t.id::text = a.entity_id)
    WHEN 'schedule' THEN (SELECT r.name || ' · ' || to_char(sc.departure_time, 'HH12:MI AM') FROM schedules sc JOIN routes r ON r.id = sc.route_id WHERE sc.id::text = a.entity_id)
    WHEN 'route' THEN (SELECT r.name FROM routes r WHERE r.id::text = a.entity_id)
    WHEN 'employee' THEN (SELECT e.employee_code || ' · ' || e.full_name FROM employees e WHERE e.id::text = a.entity_id)
    WHEN 'user' THEN (SELECT COALESCE(x.full_name, x.email) FROM users x WHERE x.id::text = a.entity_id)
    WHEN 'conductor' THEN (SELECT c.full_name FROM conductors c WHERE c.id::text = a.entity_id)
    WHEN 'staff_member' THEN (SELECT sd.full_name FROM staff_directory sd WHERE sd.id::text = a.entity_id)
    WHEN 'promo_code' THEN (SELECT 'Promo ' || pc.code FROM promo_codes pc WHERE pc.id::text = a.entity_id)
    WHEN 'trip_voucher' THEN (SELECT 'Voucher ' || v.voucher_no FROM trip_vouchers v WHERE v.id::text = a.entity_id)
    WHEN 'terminal_voucher' THEN (SELECT 'Voucher ' || v.voucher_no FROM terminal_vouchers v WHERE v.id::text = a.entity_id)
    -- Cargo: from the entry's own details (no table lookup, so the log works even before the cargo migration is run)
    WHEN 'parcel' THEN 'Parcel ' || COALESCE(a.new_data->>'parcelNo', a.entity_id)
    WHEN 'cargo_rate' THEN 'Cargo rate #' || a.entity_id
    WHEN 'cargo_settings' THEN 'Cargo settings'
    WHEN 'round_trip' THEN (SELECT rt.route_label || ' · ' || to_char(rt.report_date, 'DD Mon YYYY') FROM round_trips rt WHERE rt.id::text = a.entity_id)
    ELSE NULL
  END`;

const AUDIT_SELECT = `SELECT a.id, a.actor_id, a.action, a.entity_type, a.entity_id, a.old_data, a.new_data, host(a.ip_address) AS ip_address,
         a.created_at, u.full_name AS actor_name, u.email AS actor_email, u.role::text AS actor_role, ${AUDIT_ITEM_LABEL} AS entity_label
  FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id`;

/** "%text%" for ILIKE, with the user's own % and _ taken literally. */
const likeOf = (v) => `%${v.replace(/[\\%_]/g, (c) => "\\" + c)}%`;

router.get(
  '/audit-logs',
  validate({
    query: pagination
      .extend({
        entityType: z.string().regex(/^[a-z_]{2,40}$/).optional(),
        entityId: z.string().max(64).optional(),
        actorId: z.string().uuid().optional(),
        from: isoDate.optional(), // Pakistan dates, inclusive
        to: isoDate.optional(),
        q: z.string().trim().min(1).max(80).optional(), // PNR, item id, action, person, or any text in the details
      })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const { rows } = await query(
      `${AUDIT_SELECT}
       WHERE ($1::text IS NULL OR a.entity_type = $1::text)
         AND ($2::text IS NULL OR a.entity_id = $2::text)
         AND ($3::uuid IS NULL OR a.actor_id = $3::uuid)
         AND ($4::date IS NULL OR a.created_at >= ($4::date)::timestamp AT TIME ZONE 'Asia/Karachi')
         AND ($5::date IS NULL OR a.created_at < ($5::date + 1)::timestamp AT TIME ZONE 'Asia/Karachi')
         AND ($6::text IS NULL
              OR a.entity_id ILIKE $6::text OR a.action ILIKE $6::text OR u.full_name ILIKE $6::text
              OR a.new_data::text ILIKE $6::text OR a.old_data::text ILIKE $6::text
              OR (a.entity_type = 'booking' AND EXISTS (SELECT 1 FROM bookings b WHERE b.id::text = a.entity_id AND b.pnr ILIKE $6::text)))
       ORDER BY a.created_at DESC, a.id DESC LIMIT $7 OFFSET $8`,
      [q.entityType ?? null, q.entityId ?? null, q.actorId ?? null, q.from ?? null, q.to ?? null, q.q ? likeOf(q.q) : null, q.limit, offsetOf(q)],
    );
    res.json({ data: rows, pagination: { page: q.page, limit: q.limit } });
  },
);

/** For the filters: every item type and every person that appears in the log. */
router.get('/audit-logs/meta', async (_req, res) => {
  const [types, actors] = await Promise.all([
    query(`SELECT DISTINCT entity_type FROM audit_logs ORDER BY entity_type`),
    query(
      `SELECT u.id, COALESCE(u.full_name, u.email) AS name, u.role::text AS role
       FROM users u WHERE u.id IN (SELECT DISTINCT actor_id FROM audit_logs WHERE actor_id IS NOT NULL)
       ORDER BY 2`,
    ),
  ]);
  res.json({ data: { types: types.rows.map((r) => r.entityType), actors: actors.rows } });
});

/** One entry (a link to it opens its details). */
router.get('/audit-logs/:id', validate({ params: bigIdParam }), async (req, res) => {
  const row = await one(`${AUDIT_SELECT} WHERE a.id = $1`, [req.valid.params.id]);
  if (!row) throw AppError.notFound('Log entry not found');
  res.json({ data: row });
});

export default router;
