import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { buildUpdate, offsetOf, paged } from '../../utils/sql.js';
import {
  idParam, intId, isoDate, isoDateTime, longText, money, pagination, text, uuidParam,
} from '../../utils/schemas.js';
import { getRouteWithStops } from '../routes/routes.routes.js';
import { markPaymentRefunded } from '../bookings/bookings.service.js';

const router = Router();
router.use(requireAuth, requireRole(...ADMIN_ROLES));

// ======================= Lists for the admin panel (include inactive rows) =======================
router.get('/routes', async (_req, res) => {
  const { rows } = await query(
    `SELECT r.id, r.code, r.name, r.distance_km, r.est_duration_minutes, r.is_active,
            ot.name AS origin_terminal, dt.name AS destination_terminal,
            (SELECT count(*) FROM route_stops rs WHERE rs.route_id = r.id)::int AS stop_count
     FROM routes r
     JOIN terminals ot ON ot.id = r.origin_terminal_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id
     ORDER BY r.is_active DESC, r.name`,
  );
  res.json({ data: rows });
});

router.get('/routes/:id', validate({ params: idParam }), async (req, res) => {
  const route = await getRouteWithStops(req.valid.params.id);
  if (!route) throw AppError.notFound('Route not found');
  res.json({ data: route });
});

router.get('/locations', async (_req, res) => {
  const cities = await query(`SELECT id, name, province, country, is_active FROM cities ORDER BY name`);
  const terminals = await query(
    `SELECT t.id, t.city_id, c.name AS city_name, t.name, t.code, t.address, t.phone, t.latitude, t.longitude, t.is_active
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
 * Cash report: per day (Pakistan time) and per staff member, the cash they took for counter sales and the cash
 * they paid out for counter refunds. Net is what that person should hand in for the day.
 */
router.get('/reports/cash', validate({ query: rangeSchema }), async (req, res) => {
  const { from, to } = req.valid.query;
  const { rows } = await query(
    `WITH cash_in AS (
       SELECT (paid_at AT TIME ZONE 'Asia/Karachi')::date AS day, received_by AS staff_id,
              count(*) AS sales, sum(amount) AS taken
       FROM payments
       WHERE method = 'cash' AND paid_at IS NOT NULL AND status IN ('succeeded', 'refunded', 'partially_refunded')
         AND (paid_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2
       GROUP BY 1, 2
     ), cash_out AS (
       SELECT (processed_at AT TIME ZONE 'Asia/Karachi')::date AS day, processed_by AS staff_id,
              count(*) AS refunds, sum(amount) AS paid_out
       FROM refunds
       WHERE channel = 'counter' AND status = 'processed'
         AND (processed_at AT TIME ZONE 'Asia/Karachi')::date BETWEEN $1 AND $2
       GROUP BY 1, 2
     )
     SELECT COALESCE(i.day, o.day) AS day, COALESCE(i.staff_id, o.staff_id) AS staff_id,
            u.full_name AS staff_name, u.email AS staff_email, u.role AS staff_role,
            COALESCE(i.sales, 0)::int AS sales, COALESCE(i.taken, 0) AS taken,
            COALESCE(o.refunds, 0)::int AS refunds, COALESCE(o.paid_out, 0) AS paid_out,
            COALESCE(i.taken, 0) - COALESCE(o.paid_out, 0) AS net
     FROM cash_in i
     FULL JOIN cash_out o ON o.day = i.day AND o.staff_id IS NOT DISTINCT FROM i.staff_id
     LEFT JOIN users u ON u.id = COALESCE(i.staff_id, o.staff_id)
     ORDER BY 1 DESC, u.full_name NULLS LAST`,
    [from, to],
  );
  res.json({ data: rows });
});

router.get(
  '/audit-logs',
  validate({
    query: pagination
      .extend({ entityType: z.string().regex(/^[a-z_]{2,40}$/).optional(), entityId: z.string().max(64).optional() })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const { rows } = await query(
      `SELECT a.*, u.full_name AS actor_name FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       WHERE ($1::text IS NULL OR a.entity_type = $1) AND ($2::text IS NULL OR a.entity_id = $2)
       ORDER BY a.created_at DESC LIMIT $3 OFFSET $4`,
      [q.entityType ?? null, q.entityId ?? null, q.limit, offsetOf(q)],
    );
    res.json({ data: rows, pagination: { page: q.page, limit: q.limit } });
  },
);

export default router;
