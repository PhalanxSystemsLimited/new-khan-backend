/**
 * Cargo (staff). See cargo.service.js for the rules.
 *
 *   GET   /cargo/setup                  terminals, rates, settings, and which terminal this user books from
 *   PUT   /cargo/settings               rules / not-allowed text, overdue days, staff may change charge (admin)
 *   POST  /cargo/rates                  add a rate for a city pair (admin)
 *   PATCH /cargo/rates/:id              change a rate (admin)
 *   GET   /cargo/quote                  the rate-table charge while the booking form is filled in
 *   GET   /cargo/parcels                search (number, phone, CNIC, name), filters, pages
 *   POST  /cargo/parcels                book a parcel (counter staff: own terminal only)
 *   GET   /cargo/parcels/:id            one parcel with its history
 *   GET   /cargo/parcels/:id/slip       what the slip and labels print (with the QR code)
 *   POST  /cargo/parcels/:id/cancel     cancel a parcel not on a bus yet (reason required)
 *
 *   Bus cargo lists (cargo.lists.js):
 *   GET    /cargo/loading/:tripId/:stopId                    the "Load cargo" screen of a bus at a terminal
 *   POST   /cargo/loading/:tripId/:stopId                    put a parcel on the list { parcel: "CG-…" or a scanned link }
 *   DELETE /cargo/loading/:tripId/:stopId/parcels/:parcelId  take it off (until the voucher is generated)
 *   GET    /cargo/lists                                      find lists (CL number, bus, terminal, status, dates)
 *   GET    /cargo/lists/:id                                  one list with its parcels (screen and printed list)
 *
 *   At the destination (cargo.arrival.js):
 *   GET    /cargo/arrivals?terminalId                buses bringing parcels here, parcels waiting for collection, today's hand-overs
 *   POST   /cargo/arrivals/receive                   tick parcels off the bus { parcelIds: [..] } or { parcel: "CG-…" }
 *   POST   /cargo/parcels/:id/deliver                hand over { proof, collectorName, collectorCnic, cashReceived }
 *   POST   /cargo/parcels/:id/return                 not collected: returned to the sender { reason }
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { bigIdParam, cnic, idParam, intId, isoDate, longText, pagination, personName, phone, text } from '../../utils/schemas.js';
import {
  cancelParcel, cargoSettings, createParcel, getParcel, isCargoManager, PARCEL_STATUSES, quote, searchParcels, slipData,
} from './cargo.service.js';
import { addToList, getList, loadingView, removeFromList, searchLists } from './cargo.lists.js';
import { arrivalsView, deliverParcel, receiveParcels, returnParcel, workTerminal } from './cargo.arrival.js';
import { env } from '../../config/env.js';
import { qrSvg } from '../roundtrips/roundtrips.service.js';

export const cargoRouter = Router();
cargoRouter.use(requireAuth, requireRole(...STAFF_ROLES));
const adminOnly = requireRole(...ADMIN_ROLES);

const rupees = z.number().int().min(0).max(10_000_000);
/** Kilograms with at most 2 decimals. */
const kg = z.coerce.number().positive('Weight must be more than 0').max(10_000).transform((v) => Math.round(v * 100) / 100);
const optionalCnic = z.preprocess((v) => (v === '' || v === null ? undefined : v), cnic.optional());

// ---------------- Setup ----------------
cargoRouter.get('/setup', async (req, res) => {
  const [settings, rates, terminals, cities] = await Promise.all([
    cargoSettings(),
    query(
      `SELECT r.id, r.from_city_id, fc.name AS from_city, r.to_city_id, tc.name AS to_city, r.per_kg, r.per_piece, r.minimum,
              r.is_active, r.updated_at
       FROM cargo_rates r JOIN cities fc ON fc.id = r.from_city_id JOIN cities tc ON tc.id = r.to_city_id
       ORDER BY fc.name, tc.name`,
    ),
    query(
      `SELECT t.id, t.name, t.city_id, c.name AS city_name, t.address, t.phone FROM terminals t JOIN cities c ON c.id = t.city_id
       WHERE t.is_active AND c.is_active ORDER BY c.name, t.name`,
    ),
    query(`SELECT id, name FROM cities WHERE is_active ORDER BY name`),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    data: {
      settings,
      rates: rates.rows,
      terminals: terminals.rows,
      cities: cities.rows,
      myTerminalId: req.user.terminalId ?? null,
      canChooseTerminal: isCargoManager(req.user),
    },
  });
});

export const settingsBody = z
  .object({
    rulesText: longText(3000),
    notAllowedText: longText(1500),
    overdueDays: z.number().int().min(1).max(90),
    staffCanChangeCharge: z.boolean(),
  })
  .strict();

cargoRouter.put('/settings', adminOnly, validate({ body: settingsBody }), async (req, res) => {
  const b = req.valid.body;
  const old = await cargoSettings();
  await query(
    `UPDATE cargo_settings SET rules_text = $1, not_allowed_text = $2, overdue_days = $3, staff_can_change_charge = $4,
            updated_by = $5, updated_at = now() WHERE id = 1`,
    [b.rulesText, b.notAllowedText, b.overdueDays, b.staffCanChangeCharge, req.user.id],
  );
  await audit({ req, action: 'cargo_settings.update', entityType: 'cargo_settings', entityId: 1, oldData: old, newData: b });
  res.json({ data: await cargoSettings() });
});

export const rateBody = z
  .object({
    fromCityId: intId,
    toCityId: intId,
    perKg: rupees,
    perPiece: rupees,
    minimum: rupees,
    isActive: z.boolean().default(true),
  })
  .strict()
  .refine((r) => r.fromCityId !== r.toCityId, { message: 'From and to must be different cities', path: ['toCityId'] })
  .refine((r) => r.perKg > 0 || r.perPiece > 0 || r.minimum > 0, { message: 'Enter at least one amount', path: ['perKg'] });

const pairTaken = (e) => {
  if (e?.code === '23505') return AppError.conflict('There is already a rate for these two cities. Change that one instead.', [{ field: 'toCityId', message: 'This city pair already has a rate.' }]);
  return e;
};

cargoRouter.post('/rates', adminOnly, validate({ body: rateBody }), async (req, res) => {
  const b = req.valid.body;
  const row = await one(
    `INSERT INTO cargo_rates (from_city_id, to_city_id, per_kg, per_piece, minimum, is_active, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [b.fromCityId, b.toCityId, b.perKg, b.perPiece, b.minimum, b.isActive, req.user.id],
  ).catch((e) => {
    throw pairTaken(e);
  });
  await audit({ req, action: 'cargo_rate.create', entityType: 'cargo_rate', entityId: row.id, newData: row });
  res.status(201).json({ data: row });
});

cargoRouter.patch('/rates/:id', adminOnly, validate({ params: idParam, body: rateBody }), async (req, res) => {
  const b = req.valid.body;
  const old = await one(`SELECT * FROM cargo_rates WHERE id = $1`, [req.valid.params.id]);
  if (!old) throw AppError.notFound('Rate not found');
  const row = await one(
    `UPDATE cargo_rates SET from_city_id = $2, to_city_id = $3, per_kg = $4, per_piece = $5, minimum = $6, is_active = $7, updated_by = $8
     WHERE id = $1 RETURNING *`,
    [req.valid.params.id, b.fromCityId, b.toCityId, b.perKg, b.perPiece, b.minimum, b.isActive, req.user.id],
  ).catch((e) => {
    throw pairTaken(e);
  });
  await audit({ req, action: 'cargo_rate.update', entityType: 'cargo_rate', entityId: row.id, oldData: old, newData: row });
  res.json({ data: row });
});

// ---------------- Quote ----------------
cargoRouter.get(
  '/quote',
  validate({
    query: z
      .object({ fromTerminalId: intId, toTerminalId: intId, weightKg: kg.optional(), pieces: z.coerce.number().int().min(1).max(500).optional() })
      .strict(),
  }),
  async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ data: await quote(undefined, req.valid.query) });
  },
);

// ---------------- Parcels ----------------
cargoRouter.get(
  '/parcels',
  validate({
    query: pagination
      .extend({
        q: z.string().trim().max(300).optional(), // a scanned QR link is long
        status: z.enum(PARCEL_STATUSES).optional(),
        terminalId: intId.optional(),
        side: z.enum(['from', 'to', 'any']).default('any'),
        from: isoDate.optional(),
        to: isoDate.optional(),
      })
      .strict()
      .refine((x) => !x.from || !x.to || x.from <= x.to, '"from" must be on or before "to"'),
  }),
  async (req, res) => {
    const { rows, pagination: p } = await searchParcels(req.valid.query);
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows, pagination: p });
  },
);

export const parcelBody = z
  .object({
    fromTerminalId: intId.optional(), // counter staff: their own terminal (may be left out)
    toTerminalId: intId,
    senderName: personName,
    senderPhone: phone,
    senderCnic: cnic,
    receiverName: personName,
    receiverPhone: phone,
    receiverCnic: optionalCnic,
    description: text(2, 200),
    pieces: z.number().int().min(1).max(500),
    weightKg: kg,
    declaredValue: rupees.optional(),
    charge: rupees.optional(), // left out: the rate-table charge
    chargeNote: z.preprocess((v) => (v === '' || v === null ? undefined : v), text(3, 300).optional()),
    payment: z.enum(['paid', 'to_pay']),
  })
  .strict();

cargoRouter.post('/parcels', validate({ body: parcelBody }), async (req, res) => {
  const p = await withTransaction(async (client) => {
    const made = await createParcel(client, req.valid.body, req.user);
    await audit({ req, action: 'cargo_parcel.create', entityType: 'parcel', entityId: made.id, newData: { parcelNo: made.parcelNo, ...req.valid.body }, client });
    return made;
  });
  res.status(201).json({ data: await getParcel(p.id) });
});

cargoRouter.get('/parcels/:id', validate({ params: bigIdParam }), async (req, res) => {
  const p = await getParcel(req.valid.params.id);
  if (!p) throw AppError.notFound('Parcel not found');
  res.set('Cache-Control', 'no-store');
  res.json({ data: p });
});

cargoRouter.get('/parcels/:id/slip', validate({ params: bigIdParam }), async (req, res) => {
  const s = await slipData(req.valid.params.id);
  if (!s) throw AppError.notFound('Parcel not found');
  res.set('Cache-Control', 'no-store');
  res.json({ data: s });
});

cargoRouter.post(
  '/parcels/:id/cancel',
  validate({ params: bigIdParam, body: z.object({ reason: text(3, 300) }).strict() }),
  async (req, res) => {
    const out = await withTransaction(async (client) => {
      const r = await cancelParcel(client, { id: req.valid.params.id, reason: req.valid.body.reason, user: req.user });
      await audit({ req, action: 'cargo_parcel.cancel', entityType: 'parcel', entityId: r.id, newData: { parcelNo: r.parcelNo, reason: req.valid.body.reason }, client });
      return r;
    });
    res.json({ data: await getParcel(out.id), refundCash: out.refundCash });
  },
);

// ---------------- Bus cargo lists ----------------
const loadingParams = z.object({ tripId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER), stopId: intId }).strict();

cargoRouter.get('/loading/:tripId/:stopId', validate({ params: loadingParams }), async (req, res) => {
  const p = req.valid.params;
  res.set('Cache-Control', 'no-store');
  res.json({ data: await loadingView(undefined, { tripId: p.tripId, stopId: p.stopId, user: req.user }) });
});

cargoRouter.post(
  '/loading/:tripId/:stopId',
  validate({ params: loadingParams, body: z.object({ parcel: z.string().trim().min(1).max(300) }).strict() }),
  async (req, res) => {
    const p = req.valid.params;
    const r = await withTransaction(async (client) => {
      const out = await addToList(client, { tripId: p.tripId, stopId: p.stopId, parcel: req.valid.body.parcel, user: req.user });
      await audit({ req, client, action: 'cargo_list.add', entityType: 'cargo_list', entityId: out.list.id, newData: { listNo: out.list.listNo, parcelNo: out.parcel.parcelNo, tripId: p.tripId } });
      return out;
    });
    res.status(201).json({ data: await loadingView(undefined, { tripId: p.tripId, stopId: p.stopId, user: req.user }), added: r.parcel.parcelNo });
  },
);

cargoRouter.delete(
  '/loading/:tripId/:stopId/parcels/:parcelId',
  validate({ params: loadingParams.extend({ parcelId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) }) }),
  async (req, res) => {
    const p = req.valid.params;
    await withTransaction(async (client) => {
      const out = await removeFromList(client, { tripId: p.tripId, stopId: p.stopId, parcelId: p.parcelId, user: req.user });
      await audit({ req, client, action: 'cargo_list.remove', entityType: 'cargo_list', entityId: out.list.id, newData: { listNo: out.list.listNo, parcelNo: out.parcel.parcelNo, tripId: p.tripId } });
    });
    res.json({ data: await loadingView(undefined, { tripId: p.tripId, stopId: p.stopId, user: req.user }) });
  },
);

cargoRouter.get(
  '/lists',
  validate({
    query: pagination
      .extend({
        q: z.string().trim().max(300).optional(),
        status: z.enum(['open', 'closed', 'void']).optional(),
        terminalId: intId.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
      })
      .strict()
      .refine((x) => !x.from || !x.to || x.from <= x.to, '"from" must be on or before "to"'),
  }),
  async (req, res) => {
    const { rows, pagination: pg } = await searchLists(req.valid.query);
    res.set('Cache-Control', 'no-store');
    res.json({ data: rows, pagination: pg });
  },
);

cargoRouter.get('/lists/:id', validate({ params: bigIdParam }), async (req, res) => {
  const l = await getList(req.valid.params.id);
  if (!l) throw AppError.notFound('Cargo list not found');
  // The printed list's QR opens it in the admin panel (staff sign in).
  const url = `${(env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/admin/cargo-lists?q=${l.listNo}`;
  res.set('Cache-Control', 'no-store');
  res.json({ data: { ...l, url, qrSvg: await qrSvg(url) } });
});

// ---------------- At the destination ----------------
cargoRouter.get('/arrivals', validate({ query: z.object({ terminalId: intId.optional() }).strict() }), async (req, res) => {
  const terminalId = workTerminal(req.user, req.valid.query.terminalId);
  res.set('Cache-Control', 'no-store');
  res.json({ data: await arrivalsView(undefined, { terminalId }) });
});

export const receiveBody = z
  .object({
    terminalId: intId.optional(),
    parcelIds: z.array(z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(200).default([]),
    parcel: z.string().trim().min(1).max(300).optional(),
  })
  .strict()
  .refine((b) => b.parcelIds.length > 0 || b.parcel, 'Choose the parcels that came off the bus.');

cargoRouter.post('/arrivals/receive', validate({ body: receiveBody }), async (req, res) => {
  const b = req.valid.body;
  const out = await withTransaction(async (client) => {
    const r = await receiveParcels(client, { ...b, user: req.user });
    await audit({ req, client, action: 'cargo_parcel.receive', entityType: 'parcel', entityId: r.received.join(','), newData: { parcelNos: r.received } });
    return r;
  });
  res.json({ data: await arrivalsView(undefined, { terminalId: workTerminal(req.user, b.terminalId) }), received: out.received });
});

export const deliverBody = z
  .object({
    proof: z.enum(['receiver_cnic', 'slip']),
    collectorName: personName,
    collectorCnic: cnic,
    cashReceived: z.boolean().default(false),
  })
  .strict();

cargoRouter.post('/parcels/:id/deliver', validate({ params: bigIdParam, body: deliverBody }), async (req, res) => {
  const out = await withTransaction(async (client) => {
    const r = await deliverParcel(client, { id: req.valid.params.id, ...req.valid.body, user: req.user });
    await audit({ req, client, action: 'cargo_parcel.deliver', entityType: 'parcel', entityId: r.id, newData: { parcelNo: r.parcelNo, collectorName: req.valid.body.collectorName, proof: req.valid.body.proof, cashTaken: r.cashTaken } });
    return r;
  });
  res.json({ data: await getParcel(out.id), cashTaken: out.cashTaken });
});

cargoRouter.post(
  '/parcels/:id/return',
  validate({ params: bigIdParam, body: z.object({ reason: text(3, 300) }).strict() }),
  async (req, res) => {
    const out = await withTransaction(async (client) => {
      const r = await returnParcel(client, { id: req.valid.params.id, reason: req.valid.body.reason, user: req.user });
      await audit({ req, client, action: 'cargo_parcel.return', entityType: 'parcel', entityId: r.id, newData: { parcelNo: r.parcelNo, reason: req.valid.body.reason } });
      return r;
    });
    res.json({ data: await getParcel(out.id) });
  },
);
