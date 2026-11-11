/**
 * Terminal vouchers (staff). See tripVouchers.service.js for the rules.
 *
 *   GET  /trip-vouchers                       trips with paid seats (date range, search, pages)
 *   GET  /trip-vouchers/issued                generated / replaced / void vouchers (search by number, terminal, route)
 *   GET  /trip-vouchers/by-number/:no         find a voucher by its 10-digit number
 *   GET  /trip-vouchers/voucher/:voucherId    one voucher as printed (with QR code)
 *   POST /trip-vouchers/voucher/:voucherId/replace   bus swap: manager or admin, reason required
 *   GET  /trip-vouchers/:tripId               one trip: per terminal the voucher (or a live preview), passenger list
 *   POST /trip-vouchers/:tripId/generate      make the voucher of one terminal (counter staff: own terminal only)
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, MANAGER_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { bigIdParam, intId, isoDate, pagination, text } from '../../utils/schemas.js';
import {
  buildSnapshot, canGenerateAt, generateVoucher, loadTrip, loadVoucher, paidPassengers, PAID, replaceVoucher,
  terminalDeductions, voucherStops,
} from './tripVouchers.service.js';
import { closePreviousRoundTrip } from '../roundtrips/roundtrips.sync.js';

const router = Router();
router.use(requireAuth, requireRole(...STAFF_ROLES));

const rupees = z.number().int().min(0).max(10_000_000);
const voucherParam = z.object({ voucherId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();

// ---------------- Lists ----------------
router.get(
  '/',
  validate({
    query: pagination
      .extend({ from: isoDate.optional(), to: isoDate.optional(), q: z.string().trim().max(60).optional() })
      .strict()
      .refine((x) => !x.from || !x.to || x.from <= x.to, '"from" must be on or before "to"'),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = `
      WHERE EXISTS (SELECT 1 FROM tickets tk WHERE tk.trip_id = t.id AND tk.status IN ${PAID})
        AND ($1::date IS NULL OR (t.departure_at AT TIME ZONE 'Asia/Karachi')::date >= $1)
        AND ($2::date IS NULL OR (t.departure_at AT TIME ZONE 'Asia/Karachi')::date <= $2)
        AND ($3::text IS NULL OR t.id::text = $3 OR r.name ILIKE '%' || $3 || '%' OR r.code ILIKE '%' || $3 || '%'
             OR b.registration_no ILIKE '%' || $3 || '%' OR b.fleet_no ILIKE '%' || $3 || '%')`;
    const params = [q.from ?? null, q.to ?? null, q.q || null];
    const total = (
      await one(`SELECT count(*)::int AS n FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id ${where}`, params)
    ).n;
    const { rows } = await query(
      `SELECT t.id AS trip_id, t.departure_at, t.status, r.code AS route_code, r.name AS route_name,
              b.registration_no, b.fleet_no,
              p.seats, p.fare_total, p.boarding_terminals, p.last_update,
              (SELECT count(*) FROM trip_vouchers tv WHERE tv.trip_id = t.id AND tv.status = 'generated')::int AS vouchers_generated
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN buses b  ON b.id = t.bus_id
       CROSS JOIN LATERAL (
           SELECT count(*)::int AS seats, COALESCE(sum(CASE WHEN tk.is_free THEN 0 ELSE tk.fare_amount END), 0) AS fare_total,
                  count(DISTINCT bk.boarding_stop_id)::int AS boarding_terminals,
                  max(GREATEST(tk.updated_at, bk.updated_at)) AS last_update
           FROM tickets tk JOIN bookings bk ON bk.id = tk.booking_id
           WHERE tk.trip_id = t.id AND tk.status IN ${PAID}
       ) p
       ${where}
       ORDER BY t.departure_at DESC
       LIMIT $4 OFFSET $5`,
      [...params, q.limit, (q.page - 1) * q.limit],
    );
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } });
  },
);

router.get(
  '/issued',
  validate({
    query: pagination
      .extend({
        q: z.string().trim().max(60).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        status: z.enum(['generated', 'replaced', 'void']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = `
      WHERE ($1::text IS NULL OR v.voucher_no LIKE $1 || '%' OR v.terminal_name ILIKE '%' || $1 || '%'
             OR v.route_name ILIKE '%' || $1 || '%' OR v.bus_no ILIKE '%' || $1 || '%' OR v.trip_id::text = $1)
        AND ($2::date IS NULL OR (v.departure_at AT TIME ZONE 'Asia/Karachi')::date >= $2)
        AND ($3::date IS NULL OR (v.departure_at AT TIME ZONE 'Asia/Karachi')::date <= $3)
        AND ($4::text IS NULL OR v.status = $4)`;
    const params = [q.q || null, q.from ?? null, q.to ?? null, q.status ?? null];
    const total = (await one(`SELECT count(*)::int AS n FROM trip_vouchers v ${where}`, params)).n;
    const { rows } = await query(
      `SELECT v.id, v.voucher_no, v.trip_id, v.status, v.terminal_name, v.route_name, v.bus_no, v.departure_at,
              v.seats_boarding, v.on_board, v.terminal_cash, v.cash_to_conductor, v.generated_by_name, v.generated_at
       FROM trip_vouchers v ${where}
       ORDER BY v.generated_at DESC LIMIT $5 OFFSET $6`,
      [...params, q.limit, (q.page - 1) * q.limit],
    );
    res.json({ data: rows, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } });
  },
);

router.get('/by-number/:no', validate({ params: z.object({ no: z.string().regex(/^\d{10}$/, 'Voucher numbers have 10 digits') }).strict() }), async (req, res) => {
  const v = await one(`SELECT id, trip_id, status FROM trip_vouchers WHERE voucher_no = $1`, [req.valid.params.no]);
  if (!v) throw AppError.notFound('No voucher with that number.');
  res.json({ data: { voucherId: v.id, tripId: v.tripId, status: v.status } });
});

router.get('/voucher/:voucherId', validate({ params: voucherParam }), async (req, res) => {
  const v = await loadVoucher(req.valid.params.voucherId);
  if (!v) throw AppError.notFound('Voucher not found');
  res.set('Cache-Control', 'no-store');
  res.json({ data: v });
});

router.post(
  '/voucher/:voucherId/replace',
  requireRole(...MANAGER_ROLES),
  validate({ params: voucherParam, body: z.object({ reason: text(3, 300) }).strict() }),
  async (req, res) => {
    const { old, fresh } = await withTransaction(async (client) => {
      const r = await replaceVoucher(client, { voucherId: req.valid.params.voucherId, reason: req.valid.body.reason, user: req.user });
      await audit({
        req, client, action: 'trip_voucher.replace', entityType: 'trip_voucher', entityId: r.fresh.id,
        oldData: { voucherNo: r.old.voucherNo, busNo: r.old.busNo }, newData: { voucherNo: r.fresh.voucherNo, reason: req.valid.body.reason },
      });
      return r;
    });
    res.status(201).json({ data: await loadVoucher(fresh.id), replaced: { id: old.id, voucherNo: old.voucherNo } });
  },
);

// ---------------- One trip ----------------
router.get('/:id', validate({ params: bigIdParam }), async (req, res) => {
  const id = req.valid.params.id;
  const loaded = await loadTrip(id);
  if (!loaded) throw AppError.notFound('Trip not found');
  const { trip, stops } = loaded;
  const passengers = await paidPassengers(id);
  const { rows: vouchers } = await query(
    `SELECT id, voucher_no, boarding_stop_id, status, bus_no, generated_by_name, generated_at, closed_reason, replaces_id
     FROM trip_vouchers WHERE trip_id = $1 ORDER BY generated_at`,
    [id],
  );

  const stopById = new Map(stops.map((s) => [s.id, s]));
  const cityOf = (sid) => stopById.get(sid)?.city ?? '?';
  const terminals = [];
  for (const s of voucherStops(stops)) {
    const live = vouchers.find((v) => v.boardingStopId === s.id && v.status === 'generated');
    const history = vouchers.filter((v) => v.boardingStopId === s.id && v.status !== 'generated');
    const preview = live ? null : buildSnapshot({ stops, passengers, stop: s, deductions: await terminalDeductions(s.terminalId) });
    terminals.push({
      stopId: s.id,
      terminalId: s.terminalId,
      city: s.city,
      terminal: s.terminal,
      departureAt: s.time,
      voucher: live ?? null,
      history,
      preview,
      canGenerate: !live && canGenerateAt(req.user, s) && !['cancelled', 'arrived'].includes(trip.status),
    });
  }

  const byDestination = (list) => {
    const map = new Map();
    for (const p of list) {
      const g = map.get(p.droppingStopId) ?? { stopId: p.droppingStopId, destination: cityOf(p.droppingStopId), seats: 0, fare: 0 };
      g.seats += 1;
      g.fare += p.isFree ? 0 : Number(p.fareAmount) || 0;
      map.set(p.droppingStopId, g);
    }
    return [...map.values()].sort((a, b) => (stopById.get(a.stopId)?.stopOrder ?? 0) - (stopById.get(b.stopId)?.stopOrder ?? 0));
  };
  const travelling = passengers.filter((p) => p.status !== 'no_show');
  const lastUpdate = passengers.reduce((m, p) => (!m || new Date(p.changedAt) > new Date(m) ? p.changedAt : m), null);

  res.set('Cache-Control', 'no-store');
  res.json({
    data: {
      trip: {
        id: trip.id,
        status: trip.status,
        departureAt: trip.departureAt,
        routeCode: trip.routeCode,
        routeName: trip.routeName,
        busNo: trip.registrationNo,
        fleetNo: trip.fleetNo,
        totalSeats: trip.totalSeats,
        driverName: trip.driverName,
        conductorName: trip.conductorName,
        standInConductorName: trip.standInConductorName,
        hasConductor: Boolean(trip.conductorId || trip.standInConductorId),
      },
      terminals,
      wholeTrip: {
        destinations: byDestination(travelling),
        seats: travelling.length,
        fare: travelling.reduce((s, p) => s + (p.isFree ? 0 : Number(p.fareAmount) || 0), 0),
      },
      passengers: passengers.map((p) => ({
        ticketId: p.ticketId,
        seat: p.seatNumber,
        name: p.passengerName,
        gender: p.passengerGender,
        phone: p.passengerPhone,
        boarding: cityOf(p.boardingStopId),
        boardingStopId: p.boardingStopId,
        destination: cityOf(p.droppingStopId),
        fare: Number(p.fareAmount) || 0,
        isFree: p.isFree,
        status: p.status,
        noShowNote: p.noShowNote,
        pnr: p.pnr,
        channel: p.channel,
        paidBy: p.paidBy,
      })),
      generatedAt: new Date().toISOString(),
      lastUpdate,
    },
  });
});

router.post(
  '/:id/generate',
  validate({
    params: bigIdParam,
    body: z.object({ boardingStopId: intId, loadAmount: rupees.default(0), cargoAmount: rupees.default(0) }).strict(),
  }),
  async (req, res) => {
    const b = req.valid.body;
    const made = await withTransaction(async (client) => {
      const v = await generateVoucher(client, { tripId: req.valid.params.id, ...b, user: req.user });
      await audit({ req, client, action: 'trip_voucher.generate', entityType: 'trip_voucher', entityId: v.id, newData: { voucherNo: v.voucherNo, tripId: req.valid.params.id, ...b } });
      // The bus is leaving its first terminal: if that is Lahore or Multan, a round trip nobody marked as arrived is closed.
      const first = await one(`SELECT 1 FROM route_stops rs JOIN trips t ON t.route_id = rs.route_id WHERE t.id = $1 AND rs.id = $2 AND rs.stop_order = 1`, [req.valid.params.id, b.boardingStopId], client);
      if (first) await closePreviousRoundTrip(client, { tripId: req.valid.params.id, userId: req.user.id });
      return v;
    });
    res.status(201).json({ data: await loadVoucher(made.id) });
  },
);

export default router;
