/**
 * Round Trip Reports API.
 *   /admin/round-trips/...       admin and super admin: trips, legs, vouchers, fuel, off-route lines, tokens
 *   /admin/report-settings/...   admin and super admin: off-route categories + defaults, on-route list, platforms
 *   /reports/r/:token            the page a voucher QR opens (login required unless PUBLIC_TRIP_REPORT=true)
 * Every change is written to audit_logs (who, when, old value, new value).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { env } from '../../config/env.js';
import { validate } from '../../middleware/validate.js';
import { optionalAuth, requireAuth, requireRole, ADMIN_ROLES, isEmployee } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { offsetOf, paged } from '../../utils/sql.js';
import { bigIdParam, busClass, intId, isoDate, isoDateTime, pagination, text, time } from '../../utils/schemas.js';
import {
  applyDefaults, assertDraft, buildReport, createRoundTrip, createVoucher, logScan, previewDefaults, regenerateToken,
  resolveToken, touch, updateVoucher, voucherSlip,
} from './roundtrips.service.js';
import { fuelAmount } from './report.calc.js';
import {
  createFromTrips, MAX_LEGS, missingVouchers, scanCompletedRoundTrips, syncFromVouchers, tripOptions,
} from './roundtrips.sync.js';

// ---------------------------------------------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------------------------------------------
const rupees = z.number().int().min(0).max(100_000_000);
const count = z.number().int().min(0).max(10_000);
const bigId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const optText = (max) => text(1, max).nullable().optional();
const decimal3 = (max) => z.number().min(0).max(max).refine((n) => Math.abs(n * 1000 - Math.round(n * 1000)) < 1e-6, 'At most 3 decimals');

const tripFields = {
  routeId: intId.nullable().optional(),
  busId: intId,
  driverId: intId.nullable().optional(),
  driverName: optText(120),
  fareCollector: optText(120),
  routeLabel: text(2, 120),
  reportDate: isoDate,
  reportTime: time.nullable().optional(),
  distanceKm: z.number().min(0).max(100_000).optional(),
  mobilOil: z.number().min(0).max(100_000).optional(),
  otherExpense: rupees.optional(),
  otherExpenseNote: optText(200),
  otherIncome: rupees.optional(),
  otherIncomeNote: optText(200),
  cashierName: optText(120),
  cashReceivedAt: isoDateTime.nullable().optional(),
  inchargeName: optText(120),
};
const legInput = z.object({ title: text(2, 150), legRef: optText(40) }).strict();
const createTripSchema = z.object({ ...tripFields, legs: z.array(legInput).max(MAX_LEGS).optional() }).strict();
const updateTripSchema = z.object(tripFields).partial().strict();

const onrouteLine = z.object({ categoryId: intId.nullable().optional(), name: text(1, 60).optional(), amount: rupees }).strict();
const onlineLine = z
  .object({ platformId: intId.nullable().optional(), platformName: text(1, 60).optional(), seats: count.default(0), amount: rupees })
  .strict();
const voucherFields = {
  legId: bigId,
  sortOrder: z.number().int().min(0).max(999).optional(),
  terminalId: intId.nullable().optional(),
  terminalName: text(1, 120).optional(),
  departureAt: isoDateTime.nullable().optional(),
  paxTerminal: count.optional(),
  paxEnroute: count.optional(),
  incTerminal: rupees.optional(),
  incEnroute: rupees.optional(),
  loadAmount: rupees.optional(),
  cargoAmount: rupees.optional(),
  onroute: z.array(onrouteLine).max(40).optional(),
  online: z.array(onlineLine).max(20).optional(),
};
const createVoucherSchema = z.object(voucherFields).strict();
const updateVoucherSchema = z.object(voucherFields).partial().strict();

const fuelSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            station: text(1, 30),
            litres: decimal3(9_999_999).refine((n) => n > 0, 'Litres must be more than 0'),
            rate: decimal3(9_999_999),
            amount: rupees.optional(), // blank = round(litres × rate)
          })
          .strict(),
      )
      .max(20),
  })
  .strict();

const tripParams = z.object({ id: bigId }).strict();
const childParams = (name) => z.object({ id: bigId, [name]: bigId }).strict();

// ---------------------------------------------------------------------------------------------------------------
// Round trips (admin)
// ---------------------------------------------------------------------------------------------------------------
export const adminRoundTripsRouter = Router();
adminRoundTripsRouter.use(requireAuth, requireRole(...ADMIN_ROLES));

adminRoundTripsRouter.get(
  '/',
  validate({
    query: pagination
      .extend({ status: z.enum(['draft', 'finalized']).optional(), from: isoDate.optional(), to: isoDate.optional(), q: z.string().trim().max(40).optional() })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = `WHERE ($1::text IS NULL OR rt.status = $1) AND ($2::date IS NULL OR rt.report_date >= $2)
                     AND ($3::date IS NULL OR rt.report_date <= $3)
                     AND ($4::text IS NULL OR rt.id::text = $4 OR b.fleet_no ILIKE '%' || $4 || '%'
                          OR rt.route_label ILIKE '%' || $4 || '%'
                          OR EXISTS (SELECT 1 FROM terminal_vouchers v LEFT JOIN trip_vouchers tv ON tv.id = v.trip_voucher_id
                                     WHERE v.round_trip_id = rt.id AND COALESCE(v.voucher_no, tv.voucher_no) = $4))`;
    const params = [q.status ?? null, q.from ?? null, q.to ?? null, q.q || null];
    const total = (await one(`SELECT count(*)::int AS n FROM round_trips rt JOIN buses b ON b.id = rt.bus_id ${where}`, params)).n;
    const { rows } = await query(
      `SELECT rt.id, rt.status, rt.report_date, rt.route_label, rt.updated_at, rt.finalized_at, rt.auto_created,
              (SELECT count(*) FROM round_trip_legs l WHERE l.round_trip_id = rt.id)::int AS legs,
              COALESCE(b.fleet_no, b.registration_no) AS fleet_no,
              (SELECT count(*)::int FROM terminal_vouchers v WHERE v.round_trip_id = rt.id) AS voucher_count
       FROM round_trips rt JOIN buses b ON b.id = rt.bus_id
       ${where}
       ORDER BY rt.report_date DESC, rt.id DESC LIMIT $5 OFFSET $6`,
      [...params, q.limit, offsetOf(q)],
    );
    res.json(paged(rows, q, total));
  },
);

// ---- Built from the real trips (Phase 2) ----
/** Trips to choose from: last 10 days to 2 days ahead by default, optionally one bus. */
adminRoundTripsRouter.get(
  '/trip-options',
  validate({ query: z.object({ from: isoDate.optional(), to: isoDate.optional(), busId: intId.optional() }).strict() }),
  async (req, res) => {
    const day = (n) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' });
    const q = req.valid.query;
    res.json({ data: await tripOptions({ from: q.from ?? day(-10), to: q.to ?? day(2), busId: q.busId }) });
  },
);

adminRoundTripsRouter.post(
  '/from-trips',
  validate({ body: z.object({ outboundTripId: bigId, returnTripId: bigId.nullable().optional() }).strict() }),
  async (req, res) => {
    const out = await withTransaction(async (client) => {
      const made = await createFromTrips(client, { userId: req.user.id, ...req.valid.body });
      await audit({ req, client, action: 'round_trip.create_from_trips', entityType: 'round_trip', entityId: made.id, newData: { ...req.valid.body, ...made.sync } });
      return made;
    });
    res.status(201).json({ data: await buildReport(out.id, { admin: true }), sync: out.sync });
  },
);

/** Makes the reports of buses that came back to Lahore or Multan (arrived, last 30 days) and have none yet. */
adminRoundTripsRouter.post('/scan-completed', async (req, res) => {
  const result = await withTransaction(async (client) => {
    const r = await scanCompletedRoundTrips(client, { userId: req.user.id });
    if (r.made.length) await audit({ req, client, action: 'round_trip.auto_scan', entityType: 'round_trip', entityId: 'scan', newData: r });
    return r;
  });
  res.json({ data: result });
});

/** Copies the trips' terminal vouchers into the report again (drafts). Rows changed by hand are kept unless includeEdited. */
adminRoundTripsRouter.post(
  '/:id/sync-vouchers',
  validate({ params: tripParams, body: z.object({ includeEdited: z.boolean().default(false) }).strict() }),
  async (req, res) => {
    const id = req.valid.params.id;
    const sync = await withTransaction(async (client) => {
      await assertDraft(client, id);
      const r = await syncFromVouchers(client, id, { includeEdited: req.valid.body.includeEdited, userId: req.user.id });
      await audit({ req, client, action: 'round_trip.sync_vouchers', entityType: 'round_trip', entityId: id, newData: r });
      return r;
    });
    res.json({ data: await buildReport(id, { admin: true }), sync });
  },
);

/** Terminals of the report's trips that still have no voucher. */
adminRoundTripsRouter.get('/:id/missing-vouchers', validate({ params: tripParams }), async (req, res) => {
  res.json({ data: await missingVouchers(undefined, req.valid.params.id) });
});

adminRoundTripsRouter.post('/', validate({ body: createTripSchema }), async (req, res) => {
  const out = await withTransaction(async (client) => {
    const created = await createRoundTrip(client, { userId: req.user.id, input: req.valid.body });
    await audit({ req, client, action: 'round_trip.create', entityType: 'round_trip', entityId: created.id, newData: req.valid.body });
    return created;
  });
  res.status(201).json({ data: await buildReport(out.id, { admin: true }) });
});

adminRoundTripsRouter.get('/:id', validate({ params: tripParams }), async (req, res) => {
  const report = await buildReport(req.valid.params.id, { admin: true });
  if (!report) throw AppError.notFound('Round trip not found');
  res.set('Cache-Control', 'no-store');
  res.json({ data: report });
});

const TRIP_COLUMNS = {
  routeId: 'route_id', busId: 'bus_id', driverId: 'driver_id', driverName: 'driver_name', fareCollector: 'fare_collector',
  routeLabel: 'route_label', reportDate: 'report_date', reportTime: 'report_time', distanceKm: 'distance_km', mobilOil: 'mobil_oil',
  otherExpense: 'other_expense', otherExpenseNote: 'other_expense_note', otherIncome: 'other_income', otherIncomeNote: 'other_income_note',
  cashierName: 'cashier_name', cashReceivedAt: 'cash_received_at', inchargeName: 'incharge_name',
};

adminRoundTripsRouter.patch('/:id', validate({ params: tripParams, body: updateTripSchema }), async (req, res) => {
  const id = req.valid.params.id;
  const body = req.valid.body;
  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(TRIP_COLUMNS)) {
    if (body[field] === undefined) continue;
    values.push(body[field]);
    sets.push(`${column} = $${values.length + 1}`);
  }
  if (!sets.length) throw AppError.badRequest('No updatable fields provided');
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const before = await one(`SELECT * FROM round_trips WHERE id = $1`, [id], client);
    await client.query(`UPDATE round_trips SET ${sets.join(', ')} WHERE id = $1`, [id, ...values]);
    const oldData = Object.fromEntries(Object.keys(body).map((k) => [k, before[k]]));
    await audit({ req, client, action: 'round_trip.update', entityType: 'round_trip', entityId: id, oldData, newData: body });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

adminRoundTripsRouter.delete('/:id', validate({ params: tripParams }), async (req, res) => {
  const id = req.valid.params.id;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const before = await buildReport(id, { client });
    await client.query(`DELETE FROM round_trips WHERE id = $1`, [id]);
    await audit({ req, client, action: 'round_trip.delete', entityType: 'round_trip', entityId: id, oldData: before });
  });
  res.status(204).end();
});

adminRoundTripsRouter.post('/:id/finalize', validate({ params: tripParams }), async (req, res) => {
  const id = req.valid.params.id;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    // Built from trips: every terminal must have generated its voucher, and the copied rows are brought up to
    // date first (rows changed by hand are kept).
    const missing = await missingVouchers(client, id);
    if (missing.length) {
      throw AppError.unprocessable(
        `These terminals have not generated their voucher yet: ${missing.map((m) => m.city).join(', ')}. Generate them first (Operations → Vouchers).`,
        missing,
      );
    }
    await syncFromVouchers(client, id, { userId: req.user.id });
    const legs = await one(`SELECT count(*)::int AS n FROM terminal_vouchers WHERE round_trip_id = $1`, [id], client);
    if (!legs.n) throw AppError.unprocessable('Add at least one terminal voucher before finalizing.');
    await client.query(`UPDATE round_trips SET status = 'finalized', finalized_at = now(), finalized_by = $2 WHERE id = $1`, [id, req.user.id]);
    const snapshot = await buildReport(id, { client });
    await audit({ req, client, action: 'round_trip.finalize', entityType: 'round_trip', entityId: id, newData: { summary: snapshot.summary } });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

// ---- Legs ----
adminRoundTripsRouter.post('/:id/legs', validate({ params: tripParams, body: legInput }), async (req, res) => {
  const id = req.valid.params.id;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const n = await one(`SELECT COALESCE(max(leg_no), 0) + 1 AS n FROM round_trip_legs WHERE round_trip_id = $1`, [id], client);
    if (n.n > MAX_LEGS) throw AppError.unprocessable(`A round trip can have at most ${MAX_LEGS} legs.`);
    const leg = await one(
      `INSERT INTO round_trip_legs (round_trip_id, leg_no, title, leg_ref) VALUES ($1, $2, $3, $4) RETURNING *`,
      [id, n.n, req.valid.body.title, req.valid.body.legRef ?? null],
      client,
    );
    await touch(client, id);
    await audit({ req, client, action: 'round_trip.leg_add', entityType: 'round_trip', entityId: id, newData: leg });
  });
  res.status(201).json({ data: await buildReport(id, { admin: true }) });
});

adminRoundTripsRouter.patch('/:id/legs/:legId', validate({ params: childParams('legId'), body: legInput.partial().strict() }), async (req, res) => {
  const { id, legId } = req.valid.params;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const before = await one(`SELECT * FROM round_trip_legs WHERE id = $1 AND round_trip_id = $2`, [legId, id], client);
    if (!before) throw AppError.notFound('Leg not found');
    const b = req.valid.body;
    await client.query(`UPDATE round_trip_legs SET title = $2, leg_ref = $3 WHERE id = $1`, [
      legId, b.title ?? before.title, b.legRef !== undefined ? b.legRef : before.legRef,
    ]);
    await touch(client, id);
    await audit({ req, client, action: 'round_trip.leg_update', entityType: 'round_trip', entityId: id, oldData: before, newData: b });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

adminRoundTripsRouter.delete('/:id/legs/:legId', validate({ params: childParams('legId') }), async (req, res) => {
  const { id, legId } = req.valid.params;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const used = await one(`SELECT count(*)::int AS n FROM terminal_vouchers WHERE leg_id = $1`, [legId], client);
    if (used.n) throw AppError.unprocessable('Remove the vouchers of this leg first.');
    const before = await one(`DELETE FROM round_trip_legs WHERE id = $1 AND round_trip_id = $2 RETURNING *`, [legId, id], client);
    if (!before) throw AppError.notFound('Leg not found');
    await touch(client, id);
    await audit({ req, client, action: 'round_trip.leg_delete', entityType: 'round_trip', entityId: id, oldData: before });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

// ---- Vouchers ----
adminRoundTripsRouter.post('/:id/vouchers', validate({ params: tripParams, body: createVoucherSchema }), async (req, res) => {
  const id = req.valid.params.id;
  const created = await withTransaction(async (client) => {
    await assertDraft(client, id);
    const v = await createVoucher(client, { roundTripId: id, userId: req.user.id, v: req.valid.body });
    await touch(client, id);
    await audit({ req, client, action: 'voucher.create', entityType: 'terminal_voucher', entityId: v.id, newData: { voucherNo: v.voucherNo, roundTripId: id, ...req.valid.body } });
    return v;
  });
  res.status(201).json({ data: await buildReport(id, { admin: true }), voucher: { id: created.id, voucherNo: created.voucherNo } });
});

adminRoundTripsRouter.patch('/:id/vouchers/:voucherId', validate({ params: childParams('voucherId'), body: updateVoucherSchema }), async (req, res) => {
  const { id, voucherId } = req.valid.params;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const { before } = await updateVoucher(client, { roundTripId: id, voucherId, v: req.valid.body });
    await touch(client, id);
    await audit({ req, client, action: 'voucher.update', entityType: 'terminal_voucher', entityId: voucherId, oldData: before, newData: req.valid.body });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

adminRoundTripsRouter.delete('/:id/vouchers/:voucherId', validate({ params: childParams('voucherId') }), async (req, res) => {
  const { id, voucherId } = req.valid.params;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const before = await one(`DELETE FROM terminal_vouchers WHERE id = $1 AND round_trip_id = $2 RETURNING *`, [voucherId, id], client);
    if (!before) throw AppError.notFound('Voucher not found');
    await touch(client, id);
    await audit({ req, client, action: 'voucher.delete', entityType: 'terminal_voucher', entityId: voucherId, oldData: before });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

// ---- Fuel (replaces the whole list) ----
adminRoundTripsRouter.put('/:id/fuel', validate({ params: tripParams, body: fuelSchema }), async (req, res) => {
  const id = req.valid.params.id;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const { rows: before } = await query(`SELECT station, litres, rate, amount FROM round_trip_fuel_entries WHERE round_trip_id = $1 ORDER BY sort_order, id`, [id], client);
    await client.query(`DELETE FROM round_trip_fuel_entries WHERE round_trip_id = $1`, [id]);
    const entries = req.valid.body.entries.map((e) => ({ ...e, amount: e.amount ?? fuelAmount(e.litres, e.rate) }));
    for (const [i, e] of entries.entries()) {
      await client.query(
        `INSERT INTO round_trip_fuel_entries (round_trip_id, sort_order, station, litres, rate, amount) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, i + 1, e.station, e.litres, e.rate, e.amount],
      );
    }
    await touch(client, id);
    await audit({ req, client, action: 'round_trip.fuel', entityType: 'round_trip', entityId: id, oldData: before, newData: entries });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

// ---- Off-route lines (per-trip override: admins only for now) ----
adminRoundTripsRouter.patch(
  '/:id/offroute/:lineId',
  validate({ params: childParams('lineId'), body: z.object({ amount: rupees.optional(), reset: z.literal(true).optional() }).strict() }),
  async (req, res) => {
    const { id, lineId } = req.valid.params;
    const { amount, reset } = req.valid.body;
    if (amount === undefined && !reset) throw AppError.badRequest('Send an amount, or reset: true');
    await withTransaction(async (client) => {
      await assertDraft(client, id);
      const before = await one(`SELECT * FROM round_trip_offroute_lines WHERE id = $1 AND round_trip_id = $2`, [lineId, id], client);
      if (!before) throw AppError.notFound('Off-route line not found');
      if (reset) {
        await client.query(
          `UPDATE round_trip_offroute_lines SET amount = default_amount, is_overridden = FALSE, overridden_by = NULL, overridden_at = NULL WHERE id = $1`,
          [lineId],
        );
      } else {
        await client.query(
          `UPDATE round_trip_offroute_lines SET amount = $2, is_overridden = ($2 <> default_amount),
                  overridden_by = CASE WHEN $2 <> default_amount THEN $3::uuid END,
                  overridden_at = CASE WHEN $2 <> default_amount THEN now() END
           WHERE id = $1`,
          [lineId, amount, req.user.id],
        );
      }
      await touch(client, id);
      await audit({
        req, client, action: 'round_trip.offroute_override', entityType: 'round_trip', entityId: id,
        oldData: { line: before.name, amount: before.amount }, newData: { line: before.name, amount: reset ? before.defaultAmount : amount, reset: Boolean(reset) },
      });
    });
    res.json({ data: await buildReport(id, { admin: true }) });
  },
);

/** A line entered by hand after the trip, e.g. E-tag / toll tax (meeting, 33). Drafts only. */
adminRoundTripsRouter.post(
  '/:id/offroute',
  validate({ params: tripParams, body: z.object({ name: text(2, 80), amount: rupees }).strict() }),
  async (req, res) => {
    const id = req.valid.params.id;
    await withTransaction(async (client) => {
      await assertDraft(client, id);
      const order = await one(`SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM round_trip_offroute_lines WHERE round_trip_id = $1`, [id], client);
      await client.query(
        `INSERT INTO round_trip_offroute_lines (round_trip_id, category_id, name, amount, default_amount, sort_order)
         VALUES ($1, NULL, $2, $3, $3, $4)`,
        [id, req.valid.body.name, req.valid.body.amount, order.n],
      );
      await touch(client, id);
      await audit({ req, client, action: 'round_trip.offroute_add', entityType: 'round_trip', entityId: id, newData: req.valid.body });
    });
    res.status(201).json({ data: await buildReport(id, { admin: true }) });
  },
);

/** Removes a line entered by hand (lines copied from the defaults are changed, not removed). Drafts only. */
adminRoundTripsRouter.delete('/:id/offroute/:lineId', validate({ params: childParams('lineId') }), async (req, res) => {
  const { id, lineId } = req.valid.params;
  await withTransaction(async (client) => {
    await assertDraft(client, id);
    const before = await one(
      `DELETE FROM round_trip_offroute_lines WHERE id = $1 AND round_trip_id = $2 AND category_id IS NULL RETURNING name, amount`,
      [lineId, id],
      client,
    );
    if (!before) throw AppError.notFound('Only lines entered by hand can be removed.');
    await touch(client, id);
    await audit({ req, client, action: 'round_trip.offroute_remove', entityType: 'round_trip', entityId: id, oldData: before });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

adminRoundTripsRouter.get('/:id/offroute/defaults-preview', validate({ params: tripParams }), async (req, res) => {
  const { changes } = await previewDefaults(undefined, req.valid.params.id);
  res.json({ data: changes });
});

adminRoundTripsRouter.post(
  '/:id/offroute/apply-defaults',
  validate({ params: tripParams, body: z.object({ includeOverriddenIds: z.array(bigId).max(100).default([]) }).strict() }),
  async (req, res) => {
    const id = req.valid.params.id;
    const applied = await withTransaction(async (client) => {
      await assertDraft(client, id);
      const done = await applyDefaults(client, id, req.valid.body);
      if (done.length) await touch(client, id);
      await audit({ req, client, action: 'round_trip.apply_defaults', entityType: 'round_trip', entityId: id, newData: done });
      return done;
    });
    res.json({ data: await buildReport(id, { admin: true }), applied });
  },
);

// ---- QR tokens and scans ----
adminRoundTripsRouter.post('/:id/regenerate-token', validate({ params: tripParams, body: z.object({ voucherId: bigId.nullable().default(null) }).strict() }), async (req, res) => {
  const id = req.valid.params.id;
  const { voucherId } = req.valid.body;
  await withTransaction(async (client) => {
    const rt = await one(`SELECT id FROM round_trips WHERE id = $1 FOR UPDATE`, [id], client);
    if (!rt) throw AppError.notFound('Round trip not found');
    if (voucherId) {
      const v = await one(`SELECT id FROM terminal_vouchers WHERE id = $1 AND round_trip_id = $2`, [voucherId, id], client);
      if (!v) throw AppError.notFound('Voucher not found');
    }
    // Allowed on finalized reports too: it changes who can open the report, not its figures.
    const t = await regenerateToken(client, { roundTripId: id, voucherId, userId: req.user.id });
    await audit({ req, client, action: 'report_token.regenerate', entityType: 'round_trip', entityId: id, oldData: { tokenId: t.revokedTokenId }, newData: { voucherId, tokenId: t.id } });
  });
  res.json({ data: await buildReport(id, { admin: true }) });
});

adminRoundTripsRouter.get('/:id/scans', validate({ params: tripParams }), async (req, res) => {
  const { rows } = await query(
    `SELECT s.scanned_at, s.voucher_id, v.voucher_no, u.full_name AS user_name, s.ip_address::text AS ip
     FROM report_scans s LEFT JOIN terminal_vouchers v ON v.id = s.voucher_id LEFT JOIN users u ON u.id = s.user_id
     WHERE s.round_trip_id = $1 ORDER BY s.scanned_at DESC LIMIT 100`,
    [req.valid.params.id],
  );
  res.json({ data: rows });
});

// ---------------------------------------------------------------------------------------------------------------
// Vouchers across trips (admin): list and printed slip
// ---------------------------------------------------------------------------------------------------------------
export const adminVouchersRouter = Router();
adminVouchersRouter.use(requireAuth, requireRole(...ADMIN_ROLES));

adminVouchersRouter.get('/', validate({ query: pagination.extend({ q: z.string().trim().max(40).optional() }).strict() }), async (req, res) => {
  const q = req.valid.query;
  const where = `WHERE ($1::text IS NULL OR COALESCE(v.voucher_no, tv.voucher_no) LIKE $1 || '%' OR v.terminal_name ILIKE '%' || $1 || '%' OR v.round_trip_id::text = $1)`;
  const total = (await one(`SELECT count(*)::int AS n FROM terminal_vouchers v LEFT JOIN trip_vouchers tv ON tv.id = v.trip_voucher_id ${where}`, [q.q || null])).n;
  const { rows } = await query(
    `SELECT v.id, COALESCE(v.voucher_no, tv.voucher_no) AS voucher_no, v.trip_voucher_id IS NOT NULL AS from_voucher,
            v.round_trip_id, v.terminal_name, v.departure_at, v.pax_terminal + v.pax_enroute AS passengers,
            v.inc_terminal + v.inc_enroute + COALESCE((SELECT sum(amount) FROM voucher_online_sales s WHERE s.voucher_id = v.id), 0)::int AS total_sale,
            rt.status, rt.route_label, rt.report_date, l.title AS leg_title,
            (SELECT count(*)::int FROM report_scans s WHERE s.voucher_id = v.id) AS scans
     FROM terminal_vouchers v LEFT JOIN trip_vouchers tv ON tv.id = v.trip_voucher_id
     JOIN round_trips rt ON rt.id = v.round_trip_id JOIN round_trip_legs l ON l.id = v.leg_id
     ${where}
     ORDER BY v.id DESC LIMIT $2 OFFSET $3`,
    [q.q || null, q.limit, offsetOf(q)],
  );
  res.json(paged(rows, q, total));
});

adminVouchersRouter.get('/:id/slip', validate({ params: bigIdParam }), async (req, res) => {
  const slip = await voucherSlip(req.valid.params.id);
  if (!slip) throw AppError.notFound('Voucher not found');
  res.set('Cache-Control', 'no-store');
  res.json({ data: slip });
});

// ---------------------------------------------------------------------------------------------------------------
// Settings (admin): off-route categories and defaults, on-route categories, online platforms
// ---------------------------------------------------------------------------------------------------------------
export const reportSettingsRouter = Router();
reportSettingsRouter.use(requireAuth, requireRole(...ADMIN_ROLES));

reportSettingsRouter.get('/offroute', async (_req, res) => {
  const cats = await query(
    `SELECT id, name, sort_order, is_active, requires_hostess, bus_classes::text[] AS bus_classes, updated_at
     FROM offroute_categories ORDER BY sort_order, name`,
  );
  const defs = await query(
    `SELECT d.id, d.category_id, d.route_id, r.code AS route_code, r.name AS route_name, d.amount, d.is_enabled, d.updated_at,
            u.full_name AS updated_by_name
     FROM offroute_defaults d LEFT JOIN routes r ON r.id = d.route_id LEFT JOIN users u ON u.id = d.updated_by
     ORDER BY d.route_id NULLS FIRST, r.code`,
  );
  res.json({ data: cats.rows.map((c) => ({ ...c, defaults: defs.rows.filter((d) => d.categoryId === c.id) })) });
});

const categoryBody = z
  .object({
    name: text(2, 80),
    isActive: z.boolean().optional(),
    requiresHostess: z.boolean().optional(),
    busClasses: z.array(busClass).max(4).optional(),
    globalAmount: rupees.optional(),
  })
  .strict();

reportSettingsRouter.post('/offroute', validate({ body: categoryBody }), async (req, res) => {
  const b = req.valid.body;
  const cat = await withTransaction(async (client) => {
    const order = await one(`SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM offroute_categories`, [], client);
    const c = await one(
      `INSERT INTO offroute_categories (name, sort_order, is_active, requires_hostess, bus_classes)
       VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, FALSE), $5::bus_class[]) RETURNING *`,
      [b.name, order.n, b.isActive ?? null, b.requiresHostess ?? null, b.busClasses ?? []],
      client,
    );
    await client.query(`INSERT INTO offroute_defaults (category_id, route_id, amount, updated_by) VALUES ($1, NULL, $2, $3)`, [c.id, b.globalAmount ?? 0, req.user.id]);
    await audit({ req, client, action: 'offroute_category.create', entityType: 'offroute_category', entityId: c.id, newData: b });
    return c;
  }).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('A category with this name already exists.');
    throw err;
  });
  res.status(201).json({ data: cat });
});

reportSettingsRouter.patch('/offroute/:id', validate({ params: z.object({ id: intId }).strict(), body: categoryBody.omit({ globalAmount: true }).partial().strict() }), async (req, res) => {
  const { id } = req.valid.params;
  const b = req.valid.body;
  const cat = await withTransaction(async (client) => {
    const before = await one(`SELECT name, is_active, requires_hostess, bus_classes::text[] AS bus_classes FROM offroute_categories WHERE id = $1 FOR UPDATE`, [id], client);
    if (!before) throw AppError.notFound('Category not found');
    const c = await one(
      `UPDATE offroute_categories SET name = COALESCE($2, name), is_active = COALESCE($3, is_active),
              requires_hostess = COALESCE($4, requires_hostess), bus_classes = COALESCE($5::bus_class[], bus_classes)
       WHERE id = $1 RETURNING *`,
      [id, b.name ?? null, b.isActive ?? null, b.requiresHostess ?? null, b.busClasses ?? null],
      client,
    );
    await audit({ req, client, action: 'offroute_category.update', entityType: 'offroute_category', entityId: id, oldData: before, newData: b });
    return c;
  }).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('A category with this name already exists.');
    throw err;
  });
  res.json({ data: cat });
});

reportSettingsRouter.put('/offroute-order', validate({ body: z.object({ ids: z.array(intId).min(1).max(200) }).strict() }), async (req, res) => {
  const { ids } = req.valid.body;
  await withTransaction(async (client) => {
    const { rows: before } = await query(`SELECT id, sort_order FROM offroute_categories ORDER BY sort_order, name`, [], client);
    for (const [i, cid] of ids.entries()) await client.query(`UPDATE offroute_categories SET sort_order = $2 WHERE id = $1`, [cid, i + 1]);
    await audit({ req, client, action: 'offroute_category.reorder', entityType: 'offroute_category', entityId: 'order', oldData: before.map((r) => r.id), newData: ids });
  });
  res.json({ ok: true });
});

/** Sets the global default (routeId null) or a route's own default for one category. */
reportSettingsRouter.put(
  '/offroute-defaults',
  validate({ body: z.object({ categoryId: intId, routeId: intId.nullable(), amount: rupees, isEnabled: z.boolean().default(true) }).strict() }),
  async (req, res) => {
    const b = req.valid.body;
    const row = await withTransaction(async (client) => {
      const cat = await one(`SELECT id, name FROM offroute_categories WHERE id = $1`, [b.categoryId], client);
      if (!cat) throw AppError.notFound('Category not found');
      const before = await one(
        `SELECT amount, is_enabled FROM offroute_defaults WHERE category_id = $1 AND route_id IS NOT DISTINCT FROM $2 FOR UPDATE`,
        [b.categoryId, b.routeId],
        client,
      );
      const r = await one(
        `INSERT INTO offroute_defaults (category_id, route_id, amount, is_enabled, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT ON CONSTRAINT offroute_defaults_uq
         DO UPDATE SET amount = EXCLUDED.amount, is_enabled = EXCLUDED.is_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [b.categoryId, b.routeId, b.amount, b.isEnabled, req.user.id],
        client,
      );
      await audit({
        req, client, action: 'offroute_default.set', entityType: 'offroute_default', entityId: r.id,
        oldData: before ? { category: cat.name, routeId: b.routeId, ...before } : null,
        newData: { category: cat.name, routeId: b.routeId, amount: b.amount, isEnabled: b.isEnabled },
      });
      return r;
    });
    res.json({ data: row });
  },
);

/** Removes a route's own default (the route then uses the global default). The global default stays. */
reportSettingsRouter.delete('/offroute-defaults/:id', validate({ params: z.object({ id: intId }).strict() }), async (req, res) => {
  await withTransaction(async (client) => {
    const before = await one(`SELECT * FROM offroute_defaults WHERE id = $1 FOR UPDATE`, [req.valid.params.id], client);
    if (!before) throw AppError.notFound('Default not found');
    if (before.routeId === null) throw AppError.unprocessable('The global default cannot be removed. Set it to 0 or deactivate the category.');
    await client.query(`DELETE FROM offroute_defaults WHERE id = $1`, [before.id]);
    await audit({ req, client, action: 'offroute_default.remove', entityType: 'offroute_default', entityId: before.id, oldData: before });
  });
  res.status(204).end();
});

// ---- Fixed deductions per terminal (Adda, loader, cleaner...), copied onto each terminal voucher ----
reportSettingsRouter.get('/terminal-deductions', async (_req, res) => {
  const [terminals, categories, amounts] = await Promise.all([
    query(`SELECT t.id, c.name AS city, t.name, t.code, t.is_active FROM terminals t JOIN cities c ON c.id = t.city_id ORDER BY c.name, t.name`),
    query(`SELECT id, name, sort_order, is_active FROM onroute_categories ORDER BY sort_order, name`),
    query(`SELECT d.id, d.terminal_id, d.category_id, d.amount, d.updated_at, u.full_name AS updated_by_name
           FROM terminal_deductions d LEFT JOIN users u ON u.id = d.updated_by`),
  ]);
  res.json({ data: { terminals: terminals.rows, categories: categories.rows, amounts: amounts.rows } });
});

reportSettingsRouter.put(
  '/terminal-deductions',
  validate({ body: z.object({ terminalId: intId, categoryId: intId, amount: rupees }).strict() }),
  async (req, res) => {
    const b = req.valid.body;
    const row = await withTransaction(async (client) => {
      const names = await one(
        `SELECT (SELECT c.name || ' · ' || t.name FROM terminals t JOIN cities c ON c.id = t.city_id WHERE t.id = $1) AS terminal,
                (SELECT name FROM onroute_categories WHERE id = $2) AS category`,
        [b.terminalId, b.categoryId],
        client,
      );
      if (!names.terminal || !names.category) throw AppError.notFound('Terminal or deduction not found');
      const before = await one(`SELECT amount FROM terminal_deductions WHERE terminal_id = $1 AND category_id = $2 FOR UPDATE`, [b.terminalId, b.categoryId], client);
      const r = await one(
        `INSERT INTO terminal_deductions (terminal_id, category_id, amount, updated_by, updated_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT ON CONSTRAINT terminal_deductions_uq
         DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by, updated_at = now() RETURNING *`,
        [b.terminalId, b.categoryId, b.amount, req.user.id],
        client,
      );
      await audit({
        req, client, action: 'terminal_deduction.set', entityType: 'terminal_deduction', entityId: r.id,
        oldData: before ? { terminal: names.terminal, deduction: names.category, amount: before.amount } : null,
        newData: { terminal: names.terminal, deduction: names.category, amount: b.amount },
      });
      return r;
    });
    res.json({ data: row });
  },
);

// ---- Simple lists: on-route categories and online platforms ----
const LISTS = { onroute: { table: 'onroute_categories', entity: 'onroute_category' }, platforms: { table: 'online_platforms', entity: 'online_platform' } };
const listParam = z.object({ list: z.enum(Object.keys(LISTS)) }).strict();

reportSettingsRouter.get('/lists/:list', validate({ params: listParam }), async (req, res) => {
  const { table } = LISTS[req.valid.params.list];
  const { rows } = await query(`SELECT id, name, sort_order, is_active FROM ${table} ORDER BY sort_order, name`);
  res.json({ data: rows });
});

reportSettingsRouter.post('/lists/:list', validate({ params: listParam, body: z.object({ name: text(1, 60) }).strict() }), async (req, res) => {
  const { table, entity } = LISTS[req.valid.params.list];
  const row = await withTransaction(async (client) => {
    const r = await one(
      `INSERT INTO ${table} (name, sort_order) VALUES ($1, (SELECT COALESCE(max(sort_order), 0) + 1 FROM ${table})) RETURNING *`,
      [req.valid.body.name],
      client,
    );
    await audit({ req, client, action: `${entity}.create`, entityType: entity, entityId: r.id, newData: r });
    return r;
  }).catch((err) => {
    if (err.code === '23505') throw AppError.conflict('That name is already on the list.');
    throw err;
  });
  res.status(201).json({ data: row });
});

reportSettingsRouter.patch(
  '/lists/:list/:id',
  validate({
    params: z.object({ list: z.enum(Object.keys(LISTS)), id: intId }).strict(),
    body: z.object({ name: text(1, 60).optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(999).optional() }).strict(),
  }),
  async (req, res) => {
    const { table, entity } = LISTS[req.valid.params.list];
    const b = req.valid.body;
    const row = await withTransaction(async (client) => {
      const before = await one(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [req.valid.params.id], client);
      if (!before) throw AppError.notFound('Not found');
      const r = await one(
        `UPDATE ${table} SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), sort_order = COALESCE($4, sort_order)
         WHERE id = $1 RETURNING *`,
        [before.id, b.name ?? null, b.isActive ?? null, b.sortOrder ?? null],
        client,
      );
      await audit({ req, client, action: `${entity}.update`, entityType: entity, entityId: before.id, oldData: before, newData: b });
      return r;
    }).catch((err) => {
      if (err.code === '23505') throw AppError.conflict('That name is already on the list.');
      throw err;
    });
    res.json({ data: row });
  },
);

// ---------------------------------------------------------------------------------------------------------------
// The page a QR code opens
// ---------------------------------------------------------------------------------------------------------------
export const publicReportRouter = Router();

publicReportRouter.get('/r/:token', optionalAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Login first (unless the public view is switched on), so the answer never says whether a token exists.
  if (!env.PUBLIC_TRIP_REPORT) {
    if (!req.user) throw AppError.unauthorized('Sign in with a staff account to open this report.');
    // Staff and conductors; not drivers (the report holds the trip's money).
    if (!isEmployee(req.user) || req.user.role === 'driver') throw AppError.forbidden('Only New Khan staff can open trip reports.');
  }
  const tokenRow = await resolveToken(req.params.token);
  if (!tokenRow) throw AppError.notFound('This report link is not valid. It may have been replaced by a new one.');
  const report = await buildReport(tokenRow.roundTripId, { scannedVoucherId: tokenRow.voucherId });
  if (!report) throw AppError.notFound('This report link is not valid. It may have been replaced by a new one.');
  await logScan({ tokenRow, userId: req.user?.id, ip: req.ip }).catch((err) => req.log?.warn({ err }, 'Could not log a report scan'));
  res.json({ data: report });
});
