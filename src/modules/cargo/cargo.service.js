/**
 * Cargo (parcels sent on the buses), stage 1 part 1: rates, booking a parcel at a terminal, cancelling it, the
 * parcel's history, search. Later parts add the bus cargo lists (and the voucher's Cargo amount from them),
 * arrival and collection, SMS and reports.
 *
 * Rules:
 *  - Charge from the rate table (per city pair): the higher of weight x rate per kg and pieces x rate per piece,
 *    never below the minimum. Staff may type a different charge (unless an admin turned that off for counter
 *    staff); a charge LOWER than the rate table needs a reason. Both charges are kept.
 *  - Cargo staff book from their own terminal only (the terminal on their account).
 *    Managers and admins book from any terminal.
 *  - A parcel can be cancelled (with a reason) only while it is still "booked" (not yet on a bus);
 *    cargo staff only for parcels booked at their own terminal.
 */
import { env } from '../../config/env.js';
import { query, one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { qrSvg } from '../roundtrips/roundtrips.service.js';
import { cargoListsReady } from './cargo.lists.js';

export const PARCEL_STATUSES = ['booked', 'loaded', 'arrived', 'delivered', 'returned', 'cancelled'];
const MANAGERS = ['manager', 'admin', 'super_admin'];
export const isCargoManager = (user) => MANAGERS.includes(user?.role);
const byName = (user) => user?.fullName || user?.email || 'Staff';
const rs = (n) => `Rs ${Number(n).toLocaleString('en-US')}`;

/** The charge for a parcel from a rate, in whole rupees (rounded up), or null when there is no rate. */
export function chargeFor(rate, { weightKg, pieces }) {
  if (!rate) return null;
  // Round the weight part to paisa first so 12.1 kg x 50 is 605, not 605.0000001 -> 606.
  const byWeight = Math.ceil(Math.round(Number(weightKg) * Number(rate.perKg) * 100) / 100);
  const byPieces = Number(pieces) * Number(rate.perPiece);
  return Math.max(byWeight, byPieces, Number(rate.minimum));
}

export async function cargoSettings(client) {
  return one(`SELECT rules_text, not_allowed_text, overdue_days, staff_can_change_charge, updated_at FROM cargo_settings WHERE id = 1`, [], client);
}

/** Both terminals (with their city), checked: they exist, are in use and are in different cities. */
async function terminalPair(client, fromTerminalId, toTerminalId) {
  const { rows } = await query(
    `SELECT t.id, t.name, t.is_active, t.city_id, c.name AS city_name FROM terminals t JOIN cities c ON c.id = t.city_id
     WHERE t.id = ANY($1::int[])`,
    [[fromTerminalId, toTerminalId]],
    client,
  );
  const from = rows.find((r) => r.id === fromTerminalId);
  const to = rows.find((r) => r.id === toTerminalId);
  const no = (field, msg) => AppError.badRequest(msg, [{ field, message: msg }]);
  if (!from || !from.isActive) throw no('fromTerminalId', 'The sending terminal was not found or is not in use.');
  if (!to || !to.isActive) throw no('toTerminalId', 'The destination terminal was not found or is not in use.');
  if (from.cityId === to.cityId) throw no('toTerminalId', `Both terminals are in ${from.cityName}. Cargo goes from one city to another.`);
  return { from, to };
}

async function activeRate(client, fromCityId, toCityId) {
  return one(
    `SELECT id, per_kg, per_piece, minimum FROM cargo_rates WHERE from_city_id = $1 AND to_city_id = $2 AND is_active`,
    [fromCityId, toCityId],
    client,
  );
}

/** The rate-table charge while the form is filled in. */
export async function quote(client, { fromTerminalId, toTerminalId, weightKg, pieces }) {
  const { from, to } = await terminalPair(client, fromTerminalId, toTerminalId);
  const rate = await activeRate(client, from.cityId, to.cityId);
  return {
    fromCity: from.cityName,
    toCity: to.cityName,
    rate,
    calculatedCharge: weightKg && pieces ? chargeFor(rate, { weightKg, pieces }) : null,
  };
}

/** The terminal a parcel is booked from: cargo staff only their own; managers and admins any. */
function bookingTerminal(user, requested) {
  if (isCargoManager(user)) {
    if (!requested) throw AppError.badRequest('Choose the sending terminal.', [{ field: 'fromTerminalId', message: 'Choose the sending terminal.' }]);
    return requested;
  }
  if (!user.terminalId) throw AppError.forbidden('Your account has no terminal. Ask an admin to set one.');
  if (requested && requested !== user.terminalId) throw AppError.forbidden('You can only book parcels at your own terminal.');
  return user.terminalId;
}

/** Books a parcel. Run inside a transaction. Returns the new parcel's id and number. */
export async function createParcel(client, b, user) {
  const fromTerminalId = bookingTerminal(user, b.fromTerminalId);
  const { from, to } = await terminalPair(client, fromTerminalId, b.toTerminalId);
  const settings = await cargoSettings(client);
  const rate = await activeRate(client, from.cityId, to.cityId);
  const calculated = chargeFor(rate, b);

  let charge = b.charge ?? calculated;
  if (charge === null || charge === undefined) {
    const msg = `No cargo rate is set for ${from.cityName} → ${to.cityName}. Type the charge.`;
    throw AppError.badRequest(msg, [{ field: 'charge', message: msg }]);
  }
  const changed = calculated !== null && charge !== calculated;
  if (changed && !settings.staffCanChangeCharge && !isCargoManager(user)) {
    throw AppError.forbidden(`Only a manager can change the charge. The rate table gives ${rs(calculated)}.`);
  }
  const note = b.chargeNote?.trim() || null;
  if (calculated !== null && charge < calculated && !note) {
    const msg = `The charge is lower than the rate table (${rs(calculated)}). Say why.`;
    throw AppError.badRequest(msg, [{ field: 'chargeNote', message: msg }]);
  }
  charge = Math.round(charge);

  const p = await one(
    `INSERT INTO parcels (parcel_no, from_terminal_id, to_terminal_id, sender_name, sender_phone, sender_cnic,
                          receiver_name, receiver_phone, receiver_cnic, description, pieces, weight_kg, declared_value,
                          calculated_charge, charge, charge_note, payment, paid_at, paid_terminal_id, booked_by, booked_by_name)
     VALUES ('CG-0000000', $1::int, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::text,
             CASE WHEN $16::text = 'paid' THEN now() END, CASE WHEN $16::text = 'paid' THEN $1::int END, $17, $18)
     RETURNING id, parcel_no`,
    [fromTerminalId, to.id, b.senderName, b.senderPhone, b.senderCnic, b.receiverName, b.receiverPhone, b.receiverCnic ?? null,
      b.description, b.pieces, b.weightKg, b.declaredValue ?? null, calculated, charge, note, b.payment, user.id, byName(user)],
    client,
  );
  const paidText = b.payment === 'paid' ? `Paid ${rs(charge)}` : `Receiver pays ${rs(charge)} on collection`;
  const diff = changed ? ` (rate table ${rs(calculated)}${note ? `: ${note}` : ''})` : '';
  await addEvent(client, { parcelId: p.id, event: 'booked', terminalId: fromTerminalId, note: `${paidText}${diff}`.slice(0, 300), user });
  return p;
}

export async function addEvent(client, { parcelId, event, terminalId = null, note = null, user }) {
  await client.query(
    `INSERT INTO parcel_events (parcel_id, event, terminal_id, note, by_user, by_name) VALUES ($1, $2, $3, $4, $5, $6)`,
    [parcelId, event, terminalId, note, user?.id ?? null, byName(user)],
  );
}

/** Cancels a parcel that is not on a bus yet. Run inside a transaction. */
export async function cancelParcel(client, { id, reason, user }) {
  const p = await one(`SELECT id, parcel_no, status, from_terminal_id, payment, charge FROM parcels WHERE id = $1 FOR UPDATE`, [id], client);
  if (!p) throw AppError.notFound('Parcel not found');
  if (p.status !== 'booked') throw AppError.unprocessable(`Parcel ${p.parcelNo} is ${p.status}: only a parcel that is not on a bus yet can be cancelled.`);
  if (!isCargoManager(user) && p.fromTerminalId !== user.terminalId) {
    throw AppError.forbidden('Only the terminal that booked this parcel (or a manager) can cancel it.');
  }
  await client.query(`UPDATE parcels SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`, [id, reason]);
  // On a bus's cargo list that has not left yet: taken off it.
  let offList = '';
  if (await cargoListsReady(client)) {
    const l = await one(
      `UPDATE parcels p SET list_id = NULL FROM cargo_lists l WHERE p.id = $1 AND l.id = p.list_id RETURNING l.list_no`,
      [id],
      client,
    );
    if (l) offList = ` Taken off cargo list ${l.listNo}.`;
  }
  const money = (p.payment === 'paid' ? ` Give back ${rs(p.charge)} to the sender.` : '') + offList;
  await addEvent(client, { parcelId: id, event: 'cancelled', terminalId: user.terminalId ?? null, note: `${reason.replace(/[.\s]+$/, '')}.${money}`.slice(0, 300), user });
  return { ...p, status: 'cancelled', refundCash: p.payment === 'paid' ? p.charge : 0 };
}

const PARCEL_SELECT = `
  SELECT p.*, ft.name AS from_terminal, fc.name AS from_city, ft.address AS from_address, ft.phone AS from_phone,
         tt.name AS to_terminal, tc.name AS to_city, tt.address AS to_address, tt.phone AS to_phone
  FROM parcels p
  JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
  JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id`;

export async function getParcel(id, client) {
  const p = await one(`${PARCEL_SELECT} WHERE p.id = $1`, [id], client);
  if (!p) return null;
  // The bus cargo list it is on (the column exists once the cargo lists migration is run).
  if (p.listId) {
    p.list = await one(
      `SELECT l.id, l.list_no, l.status, l.trip_id, l.boarding_stop_id, COALESCE(l.bus_no, b.registration_no) AS bus_no, r.name AS route_name,
              t.departure_at + make_interval(mins => rs.minutes_from_origin) AS leaves_at, v.voucher_no
       FROM cargo_lists l JOIN trips t ON t.id = l.trip_id JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
       JOIN route_stops rs ON rs.id = l.boarding_stop_id LEFT JOIN trip_vouchers v ON v.id = l.voucher_id
       WHERE l.id = $1`,
      [p.listId],
      client,
    );
  }
  const { rows: events } = await query(
    `SELECT e.id, e.event, e.note, e.by_name, e.created_at, t.name AS terminal_name, c.name AS city_name
     FROM parcel_events e LEFT JOIN terminals t ON t.id = e.terminal_id LEFT JOIN cities c ON c.id = t.city_id
     WHERE e.parcel_id = $1 ORDER BY e.created_at, e.id`,
    [id],
    client,
  );
  return { ...p, events };
}

/** The link in the slip's QR code: the parcel in the admin panel (staff sign in to open it). */
export const parcelUrl = (parcelNo) => `${(env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/admin/parcels?q=${parcelNo}`;

/** Everything printed on the slip and the labels. */
export async function slipData(id, client) {
  const p = await getParcel(id, client);
  if (!p) return null;
  const s = await cargoSettings(client);
  const url = parcelUrl(p.parcelNo);
  return { ...p, rulesText: s.rulesText, notAllowedText: s.notAllowedText, url, qrSvg: await qrSvg(url) };
}

/**
 * Search: a parcel number (CG-0000123, also inside a scanned QR link), a phone number (last 10 digits),
 * a CNIC (13 digits), or part of a name / description. Filters: status, terminal (sent from or going to), dates.
 */
export function searchWhere(q) {
  const conds = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    conds.push(sql.replaceAll('$?', `$${params.length}`));
  };
  const text = (q.q ?? '').trim();
  if (text) {
    const no = text.toUpperCase().match(/CG-?(\d{1,8})/);
    const list = text.toUpperCase().match(/CL-?(\d{1,8})/);
    const digits = text.replace(/\D/g, '');
    if (no) add(`p.parcel_no = $?`, `CG-${no[1].padStart(7, '0')}`);
    else if (list) add(`p.list_id = (SELECT id FROM cargo_lists WHERE list_no = $?)`, `CL-${list[1].padStart(6, '0')}`);
    else if (digits.length === 13 && /^[\d\s-]+$/.test(text)) add(`(replace(p.sender_cnic, '-', '') = $? OR replace(p.receiver_cnic, '-', '') = $?)`, digits);
    else if (digits.length >= 10 && /^[\d\s+()-]+$/.test(text)) {
      add(`(right(regexp_replace(p.sender_phone, '\\D', '', 'g'), 10) = $? OR right(regexp_replace(p.receiver_phone, '\\D', '', 'g'), 10) = $?)`, digits.slice(-10));
    } else {
      add(`(p.sender_name ILIKE $? OR p.receiver_name ILIKE $? OR p.description ILIKE $?)`, `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
  }
  if (q.status) add(`p.status = $?`, q.status);
  if (q.terminalId) {
    if (q.side === 'from') add(`p.from_terminal_id = $?`, q.terminalId);
    else if (q.side === 'to') add(`p.to_terminal_id = $?`, q.terminalId);
    else add(`(p.from_terminal_id = $? OR p.to_terminal_id = $?)`, q.terminalId);
  }
  if (q.from) add(`p.created_at >= ($?::date)::timestamp AT TIME ZONE 'Asia/Karachi'`, q.from);
  if (q.to) add(`p.created_at < ($?::date + 1)::timestamp AT TIME ZONE 'Asia/Karachi'`, q.to);
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
}

export async function searchParcels(q, client) {
  const { where, params } = searchWhere(q);
  const total = (await one(`SELECT count(*)::int AS n FROM parcels p ${where}`, params, client)).n;
  const { rows } = await query(
    `${PARCEL_SELECT} ${where} ORDER BY p.created_at DESC, p.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.limit, (q.page - 1) * q.limit],
    client,
  );
  return { rows, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } };
}
