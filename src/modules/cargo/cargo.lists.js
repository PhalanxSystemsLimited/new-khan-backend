/**
 * Bus cargo lists (cargo stage 1 part 2): the parcels one bus carries from one terminal.
 *
 * Rules:
 *  - One list per trip per terminal (like vouchers). It is made when the first parcel is put on it.
 *  - Only parcels BOOKED AT THAT TERMINAL, still waiting there (status booked, on no list), going to a later stop
 *    of the bus's route can be put on it. Cargo staff only at their own terminal; managers and admins anywhere
 *    (same as generating the voucher).
 *  - Parcels can be added and removed until the terminal generates its voucher. Generating it closes the list:
 *    the voucher's Cargo amount is the list's PAID total (receiver-pays parcels are collected at the destination),
 *    the totals are frozen, and the parcels become "loaded".
 *  - A replaced voucher (bus swap) keeps the list: it moves to the new voucher and bus.
 *  - A cancelled trip voids its lists: the parcels go back to "booked" at their terminal, to go on another bus.
 *
 * The trip row is locked (FOR UPDATE) while a list changes, as when a voucher is generated, so a parcel can never be
 * added after the voucher froze the list.
 *
 * Screens that are not about cargo (counter, vouchers, trip status) call these only when the cargo tables exist
 * (cargoListsReady), so they keep working if the code goes live before the migration is run.
 */
import { query, one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';

const MANAGERS = ['manager', 'admin', 'super_admin'];
const byName = (user) => user?.fullName || user?.email || 'Staff';
const rs = (n) => `Rs ${Number(n).toLocaleString('en-US')}`;
const pkTime = (d) =>
  new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

let ready = false;
let checkedAt = 0;
/** True once the cargo list tables exist (migration 2026-11-18 run). Checked at most once a minute until then. */
export async function cargoListsReady(client) {
  if (ready) return true;
  if (Date.now() - checkedAt < 60_000) return false;
  checkedAt = Date.now();
  const r = await one(`SELECT to_regclass('public.cargo_lists') IS NOT NULL AND to_regclass('public.parcels') IS NOT NULL AS ok`, [], client);
  ready = Boolean(r?.ok);
  return ready;
}
/** For tests. */
export const resetCargoListsReady = () => {
  ready = false;
  checkedAt = 0;
};

/** The trip and the terminal (route stop) a list belongs to, with the stops after it. */
async function tripAndStop(client, tripId, stopId, { lock = false } = {}) {
  const trip = await one(
    `SELECT t.id, t.status::text AS status, t.route_id, t.departure_at, t.delay_minutes, r.name AS route_name,
            b.registration_no AS bus_no, b.fleet_no
     FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
     WHERE t.id = $1 ${lock ? 'FOR UPDATE OF t' : ''}`,
    [tripId],
    client,
  );
  if (!trip) throw AppError.notFound('Trip not found');
  const { rows: stops } = await query(
    `SELECT rs.id, rs.stop_order, rs.terminal_id, rs.is_boarding_point, c.id AS city_id, c.name AS city, tm.name AS terminal,
            $2::timestamptz + make_interval(mins => rs.minutes_from_origin) AS time
     FROM route_stops rs JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
     WHERE rs.route_id = $1 ORDER BY rs.stop_order`,
    [trip.routeId, trip.departureAt],
    client,
  );
  const i = stops.findIndex((s) => s.id === stopId);
  const stop = stops[i];
  // Like vouchers: a boarding point that is not the last stop.
  if (!stop || !stop.isBoardingPoint || i === stops.length - 1) throw AppError.badRequest('That terminal is not a boarding point of this trip.');
  return { trip, stop, later: stops.slice(i + 1) };
}

/** Cargo staff only at their own terminal; managers and admins anywhere. Counter staff: view only. */
const canLoadAt = (user, stop) => MANAGERS.includes(user.role) || (user.role === 'cargo' && Boolean(user.terminalId) && user.terminalId === stop.terminalId);

const LIST_TOTALS = `
  count(*)::int AS parcel_count,
  count(DISTINCT right(regexp_replace(p.receiver_phone, '\\D', '', 'g'), 10))::int AS receiver_count,
  COALESCE(sum(p.pieces), 0)::int AS pieces,
  COALESCE(sum(p.weight_kg), 0) AS weight_kg,
  COALESCE(sum(p.charge) FILTER (WHERE p.payment = 'paid'), 0)::int AS paid_total,
  COALESCE(sum(p.charge) FILTER (WHERE p.payment = 'to_pay' AND p.paid_at IS NULL), 0)::int AS to_pay_total`;

/** Live totals of a list from its parcels. */
async function liveTotals(client, listId) {
  return one(`SELECT ${LIST_TOTALS} FROM parcels p WHERE p.list_id = $1`, [listId], client);
}

/** The live (open or closed) list of a trip at a terminal, or null. */
async function liveList(client, tripId, stopId, { lock = false } = {}) {
  return one(
    `SELECT * FROM cargo_lists WHERE trip_id = $1 AND boarding_stop_id = $2 AND status <> 'void' ${lock ? 'FOR UPDATE' : ''}`,
    [tripId, stopId],
    client,
  );
}

const PARCEL_COLS = `p.id, p.parcel_no, p.status, p.list_id, p.from_terminal_id, p.to_terminal_id, p.sender_name, p.receiver_name,
  p.receiver_phone, p.description, p.pieces, p.weight_kg, p.charge, p.payment, p.paid_at, p.created_at,
  tt.name AS to_terminal, tc.name AS to_city`;

/**
 * The "Load cargo" screen of a trip at a terminal: the list (if any) with its parcels and totals, and the parcels
 * waiting at this terminal that this bus can take (going to one of its later stops).
 */
export async function loadingView(client, { tripId, stopId, user }) {
  const { trip, stop, later } = await tripAndStop(client, tripId, stopId);
  const list = await liveList(client, tripId, stopId);
  const voucher = await one(
    `SELECT id, voucher_no FROM trip_vouchers WHERE trip_id = $1 AND boarding_stop_id = $2 AND status = 'generated'`,
    [tripId, stopId],
    client,
  );
  const onList = list
    ? (await query(
        `SELECT ${PARCEL_COLS} FROM parcels p JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id
         WHERE p.list_id = $1 ORDER BY tc.name, p.parcel_no`,
        [list.id],
        client,
      )).rows
    : [];
  const laterTerminals = later.map((s) => s.terminalId);
  const waiting = (
    await query(
      `SELECT ${PARCEL_COLS} FROM parcels p JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id
       WHERE p.status = 'booked' AND p.list_id IS NULL AND p.from_terminal_id = $1 AND p.to_terminal_id = ANY ($2::int[])
       ORDER BY p.created_at`,
      [stop.terminalId, laterTerminals],
      client,
    )
  ).rows;
  // Waiting here but this bus does not go there (shown as a count, so staff know they need another bus).
  const otherWaiting = (
    await one(
      `SELECT count(*)::int AS n FROM parcels p WHERE p.status = 'booked' AND p.list_id IS NULL AND p.from_terminal_id = $1
         AND NOT (p.to_terminal_id = ANY ($2::int[]))`,
      [stop.terminalId, laterTerminals],
      client,
    )
  ).n;
  const totals = list ? (list.status === 'open' ? await liveTotals(client, list.id) : frozenTotals(list)) : null;
  const open = !voucher && !['cancelled', 'arrived'].includes(trip.status);
  return {
    trip: { id: trip.id, status: trip.status, routeName: trip.routeName, busNo: trip.busNo, fleetNo: trip.fleetNo, departureAt: trip.departureAt },
    stop: { id: stop.id, terminalId: stop.terminalId, city: stop.city, terminal: stop.terminal, time: stop.time },
    destinations: later.map((s) => ({ terminalId: s.terminalId, city: s.city, terminal: s.terminal })),
    list: list ? { ...list, ...totals } : null,
    voucher,
    parcels: onList,
    waiting,
    otherWaiting,
    canEdit: open && (!list || list.status === 'open') && canLoadAt(user, stop),
    canLoadHere: canLoadAt(user, stop),
  };
}

const frozenTotals = (l) => ({
  parcelCount: l.parcelCount, receiverCount: l.receiverCount, pieces: l.pieces, weightKg: l.weightKg, paidTotal: l.paidTotal, toPayTotal: l.toPayTotal,
});

/** Why a list cannot change right now (or null). Run with the trip locked. */
async function checkCanEdit(client, { trip, stop, user }) {
  if (!canLoadAt(user, stop)) {
    throw AppError.forbidden(user.terminalId ? `Only ${stop.city} cargo staff (or a manager) can load cargo here.` : 'Your account has no terminal. Ask an admin to set one.');
  }
  if (['cancelled', 'arrived'].includes(trip.status)) throw AppError.unprocessable(`This trip is ${trip.status}.`);
  const v = await one(`SELECT voucher_no FROM trip_vouchers WHERE trip_id = $1 AND boarding_stop_id = $2 AND status = 'generated'`, [trip.id, stop.id], client);
  if (v) throw AppError.unprocessable(`The ${stop.city} voucher is already generated (no. ${v.voucherNo}): the cargo list is closed.`);
}

/** "CG-0000123", "cg-123", or a scanned slip QR link -> "CG-0000123" (null when there is no parcel number). */
export function parcelNoFrom(text) {
  const m = String(text ?? '').toUpperCase().match(/CG-?(\d{1,8})/);
  return m ? `CG-${m[1].padStart(7, '0')}` : null;
}

const STATUS_WORD = { loaded: 'already on a bus', arrived: 'already arrived', delivered: 'already delivered', returned: 'returned to the sender', cancelled: 'cancelled' };

/** Puts a parcel on the bus's list at this terminal (making the list when it is the first). Run inside a transaction. */
export async function addToList(client, { tripId, stopId, parcel: text, user }) {
  const no = parcelNoFrom(text);
  if (!no) throw AppError.badRequest('Type or scan a parcel number (CG-…).', [{ field: 'parcel', message: 'Not a parcel number.' }]);
  const { trip, stop, later } = await tripAndStop(client, tripId, stopId, { lock: true });
  await checkCanEdit(client, { trip, stop, user });

  const p = await one(
    `SELECT p.id, p.parcel_no, p.status, p.list_id, p.from_terminal_id, p.to_terminal_id, ft.name AS from_terminal, fc.name AS from_city,
            tc.name AS to_city, l.list_no AS on_list_no, lb.registration_no AS on_bus
     FROM parcels p
     JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
     JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id
     LEFT JOIN cargo_lists l ON l.id = p.list_id LEFT JOIN trips lt ON lt.id = l.trip_id LEFT JOIN buses lb ON lb.id = lt.bus_id
     WHERE p.parcel_no = $1 FOR UPDATE OF p`,
    [no],
    client,
  );
  const say = (msg) => AppError.unprocessable(msg, [{ field: 'parcel', message: msg }]);
  if (!p) throw AppError.notFound(`No parcel ${no}.`, [{ field: 'parcel', message: `No parcel ${no}.` }]);
  if (p.status !== 'booked') throw say(`${no} is ${STATUS_WORD[p.status] ?? p.status}.`);
  if (p.listId) throw say(`${no} is already on cargo list ${p.onListNo} (bus ${p.onBus}). Remove it there first.`);
  if (p.fromTerminalId !== stop.terminalId) throw say(`${no} was booked at ${p.fromCity} · ${p.fromTerminal}: it can only be loaded there.`);
  if (!later.some((s) => s.terminalId === p.toTerminalId)) throw say(`${no} goes to ${p.toCity}: this bus does not stop there.`);

  let list = await liveList(client, tripId, stopId, { lock: true });
  if (list && list.status !== 'open') throw say('This cargo list is closed.');
  if (!list) {
    list = await one(
      `INSERT INTO cargo_lists (list_no, trip_id, boarding_stop_id, terminal_id, bus_no, created_by, created_by_name)
       VALUES ('CL-000000', $1, $2, $3, $4, $5, $6) RETURNING *`,
      [tripId, stopId, stop.terminalId, trip.busNo, user.id ?? null, byName(user)],
      client,
    );
  }
  await client.query(`UPDATE parcels SET list_id = $2 WHERE id = $1`, [p.id, list.id]);
  await addEvent(client, {
    parcelId: p.id, event: 'listed', terminalId: stop.terminalId, user,
    note: `On cargo list ${list.listNo}: bus ${trip.busNo}, ${trip.routeName}, leaves ${stop.city} ${pkTime(stop.time)}`,
  });
  return { list, parcel: { id: p.id, parcelNo: no } };
}

/** Takes a parcel off an open list (it waits at the terminal again). Run inside a transaction. */
export async function removeFromList(client, { tripId, stopId, parcelId, user }) {
  const { trip, stop } = await tripAndStop(client, tripId, stopId, { lock: true });
  await checkCanEdit(client, { trip, stop, user });
  const list = await liveList(client, tripId, stopId, { lock: true });
  const p = await one(`SELECT id, parcel_no, list_id FROM parcels WHERE id = $1 FOR UPDATE`, [parcelId], client);
  if (!p || !list || p.listId !== list.id) throw AppError.notFound('That parcel is not on this cargo list.');
  await client.query(`UPDATE parcels SET list_id = NULL WHERE id = $1`, [p.id]);
  await addEvent(client, { parcelId: p.id, event: 'unlisted', terminalId: stop.terminalId, user, note: `Taken off cargo list ${list.listNo} (bus ${trip.busNo})` });
  return { list, parcel: p };
}

/** The open list's live totals at a terminal (for the voucher preview and generation), or null without parcels. */
export async function openListTotals(client, tripId, stopId) {
  const list = await liveList(client, tripId, stopId);
  if (!list || list.status !== 'open') return null;
  const t = await liveTotals(client, list.id);
  return t.parcelCount > 0 ? { listId: list.id, listNo: list.listNo, ...t } : null;
}

/**
 * Called inside generateVoucher after the voucher is inserted (trip locked): closes the open list.
 * Parcels become "loaded"; an empty list is voided. Returns the closed list's totals or null.
 */
export async function closeListForVoucher(client, { tripId, stopId, voucher, busNo, stopCity, user }) {
  const list = await liveList(client, tripId, stopId, { lock: true });
  if (!list || list.status !== 'open') return null;
  const t = await liveTotals(client, list.id);
  if (t.parcelCount === 0) {
    await client.query(`UPDATE cargo_lists SET status = 'void', void_reason = 'Empty when the voucher was generated', closed_at = now(), closed_by_name = $2 WHERE id = $1`, [list.id, byName(user)]);
    return null;
  }
  await client.query(
    `UPDATE cargo_lists SET status = 'closed', voucher_id = $2, bus_no = $3, parcel_count = $4, receiver_count = $5, pieces = $6,
            weight_kg = $7, paid_total = $8, to_pay_total = $9, closed_at = now(), closed_by_name = $10
     WHERE id = $1`,
    [list.id, voucher.id, busNo, t.parcelCount, t.receiverCount, t.pieces, t.weightKg, t.paidTotal, t.toPayTotal, byName(user)],
  );
  const { rows } = await query(`UPDATE parcels SET status = 'loaded' WHERE list_id = $1 AND status = 'booked' RETURNING id`, [list.id], client);
  for (const r of rows) {
    await addEvent(client, {
      parcelId: r.id, event: 'loaded', terminalId: null, user,
      note: `Left ${stopCity} on bus ${busNo}: voucher ${voucher.voucherNo}, cargo list ${list.listNo}`,
    });
  }
  return { listId: list.id, listNo: list.listNo, ...t };
}

/** A replaced voucher (bus swap): the list moves to the new voucher and bus, and its parcels' history says so. */
export async function moveListToVoucher(client, { oldVoucherId, voucher, busNo, user }) {
  const list = await one(`UPDATE cargo_lists SET voucher_id = $2, bus_no = $3 WHERE voucher_id = $1 RETURNING id, list_no`, [oldVoucherId, voucher.id, busNo], client);
  if (!list) return null;
  const { rows } = await query(`SELECT id FROM parcels WHERE list_id = $1 AND status = 'loaded'`, [list.id], client);
  for (const r of rows) {
    await addEvent(client, { parcelId: r.id, event: 'bus_changed', user, note: `Bus changed: now on bus ${busNo}, voucher ${voucher.voucherNo} (cargo list ${list.listNo})` });
  }
  return list;
}

/** A cancelled trip: its lists are voided and their parcels go back to "booked" at their terminal. */
export async function voidListsForCancelledTrip(client, { tripId, reason, user }) {
  const { rows: lists } = await query(
    `UPDATE cargo_lists SET status = 'void', void_reason = $2, closed_at = COALESCE(closed_at, now()), closed_by_name = COALESCE(closed_by_name, $3)
     WHERE trip_id = $1 AND status <> 'void' RETURNING id, list_no`,
    [tripId, `Trip cancelled: ${reason}`.slice(0, 300), byName(user)],
    client,
  );
  let parcels = 0;
  for (const l of lists) {
    const { rows } = await query(
      `UPDATE parcels SET list_id = NULL, status = 'booked' WHERE list_id = $1 AND status IN ('booked', 'loaded') RETURNING id, from_terminal_id`,
      [l.id],
      client,
    );
    for (const r of rows) {
      await addEvent(client, { parcelId: r.id, event: 'unlisted', terminalId: r.fromTerminalId, user, note: `Trip cancelled: off cargo list ${l.listNo}. Put it on another bus.` });
    }
    parcels += rows.length;
  }
  return { lists: lists.length, parcels };
}

async function addEvent(client, { parcelId, event, terminalId = null, note = null, user }) {
  await client.query(
    `INSERT INTO parcel_events (parcel_id, event, terminal_id, note, by_user, by_name) VALUES ($1, $2, $3, $4, $5, $6)`,
    [parcelId, event, terminalId, note?.slice(0, 300) ?? null, user?.id ?? null, byName(user)],
  );
}

// ---------------- Lists: find and print ----------------
const LIST_SELECT = `
  SELECT l.*, t.departure_at, r.name AS route_name, tm.name AS terminal_name, c.name AS city_name,
         rs.minutes_from_origin, t.departure_at + make_interval(mins => rs.minutes_from_origin) AS leaves_at,
         v.voucher_no, v.status AS voucher_status, COALESCE(l.bus_no, b.registration_no) AS bus
  FROM cargo_lists l
  JOIN trips t ON t.id = l.trip_id JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
  JOIN route_stops rs ON rs.id = l.boarding_stop_id
  LEFT JOIN terminals tm ON tm.id = l.terminal_id LEFT JOIN cities c ON c.id = tm.city_id
  LEFT JOIN trip_vouchers v ON v.id = l.voucher_id`;

/** One list with its parcels (for the screen and the printed list). */
export async function getList(id, client) {
  const l = await one(`${LIST_SELECT} WHERE l.id = $1`, [id], client);
  if (!l) return null;
  const { rows: parcels } = await query(
    `SELECT ${PARCEL_COLS} FROM parcels p JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id
     WHERE p.list_id = $1 ORDER BY tc.name, p.parcel_no`,
    [id],
    client,
  );
  const totals = l.status === 'open' ? await liveTotals(client, id) : frozenTotals(l);
  return { ...l, ...totals, parcels };
}

/** Search lists: number (CL-000012, also inside a scanned link), bus number, terminal, status, dates. */
export async function searchLists(q, client) {
  const conds = [];
  const params = [];
  const add = (sql, v) => {
    params.push(v);
    conds.push(sql.replaceAll('$?', `$${params.length}`));
  };
  const text = (q.q ?? '').trim();
  if (text) {
    const no = text.toUpperCase().match(/CL-?(\d{1,8})/);
    if (no) add(`l.list_no = $?`, `CL-${no[1].padStart(6, '0')}`);
    else add(`(COALESCE(l.bus_no, b.registration_no) ILIKE $? OR b.fleet_no ILIKE $? OR r.name ILIKE $?)`, `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (q.status) add(`l.status = $?`, q.status);
  if (q.terminalId) add(`l.terminal_id = $?`, q.terminalId);
  if (q.from) add(`(t.departure_at + make_interval(mins => rs.minutes_from_origin)) >= ($?::date)::timestamp AT TIME ZONE 'Asia/Karachi'`, q.from);
  if (q.to) add(`(t.departure_at + make_interval(mins => rs.minutes_from_origin)) < ($?::date + 1)::timestamp AT TIME ZONE 'Asia/Karachi'`, q.to);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const total = (
    await one(
      `SELECT count(*)::int AS n FROM cargo_lists l JOIN trips t ON t.id = l.trip_id JOIN routes r ON r.id = t.route_id
       JOIN buses b ON b.id = t.bus_id JOIN route_stops rs ON rs.id = l.boarding_stop_id ${where}`,
      params,
      client,
    )
  ).n;
  const { rows } = await query(
    `SELECT x.*, lt.parcel_count AS live_parcel_count, lt.pieces AS live_pieces, lt.paid_total AS live_paid_total, lt.to_pay_total AS live_to_pay_total,
            lt.receiver_count AS live_receiver_count
     FROM (${LIST_SELECT} ${where} ORDER BY l.created_at DESC, l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}) x
     LEFT JOIN LATERAL (SELECT ${LIST_TOTALS} FROM parcels p WHERE p.list_id = x.id) lt ON x.status = 'open'
     ORDER BY x.created_at DESC, x.id DESC`,
    [...params, q.limit, (q.page - 1) * q.limit],
    client,
  );
  const out = rows.map((r) =>
    r.status === 'open'
      ? { ...r, parcelCount: r.liveParcelCount ?? 0, pieces: r.livePieces ?? 0, paidTotal: r.livePaidTotal ?? 0, toPayTotal: r.liveToPayTotal ?? 0, receiverCount: r.liveReceiverCount ?? 0 }
      : r,
  );
  return { rows: out, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } };
}

/** Each departure's cargo at a terminal, for the counter screen: { [tripId]: { listId, listNo, status, parcelCount, waiting } }. */
export async function cargoForDepartures(client, { terminalId, trips }) {
  if (!trips.length) return { byTrip: {}, waiting: 0 };
  const { rows } = await query(
    `SELECT l.trip_id, l.id, l.list_no, l.status,
            CASE WHEN l.status = 'open' THEN (SELECT count(*) FROM parcels p WHERE p.list_id = l.id)::int ELSE l.parcel_count END AS parcel_count
     FROM cargo_lists l WHERE l.trip_id = ANY ($1::bigint[]) AND l.terminal_id = $2 AND l.status <> 'void'`,
    [trips.map((t) => t.tripId), terminalId],
    client,
  );
  const waiting = (
    await one(`SELECT count(*)::int AS n FROM parcels WHERE status = 'booked' AND list_id IS NULL AND from_terminal_id = $1`, [terminalId], client)
  ).n;
  const out = {};
  for (const r of rows) out[r.tripId] = { listId: r.id, listNo: r.listNo, status: r.status, parcelCount: r.parcelCount };
  return { byTrip: out, waiting };
}

export { rs as rupees };
