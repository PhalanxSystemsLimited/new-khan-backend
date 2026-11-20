/**
 * Extra load slips (LD-000001 ...): a passenger's extra luggage, paid for and tied to their booking.
 *
 *  - Counter staff (their own terminal) or a manager / admin add a slip to a PAID booking that boards at that terminal,
 *    until that terminal's voucher is generated. The voucher's Load is then the total of those slips (not typed), and
 *    the slips are frozen on it (voucher_id). A replaced voucher hands its slips to the new one.
 *  - The trip's conductor (or stand-in, or a manager) can add a slip on the road, once the bus has left its first
 *    terminal and until it arrives. That cash stays with him: it is not on any terminal voucher. stop_id = the last
 *    terminal the bus left (like his road passengers), and the round trip report counts it at that stage.
 *  - A slip is never deleted. A mistake is cancelled with a reason: a counter slip by that terminal's counter staff
 *    before the voucher (a manager also after it); a conductor slip by the conductor before the trip arrives (a
 *    manager any time). A cancelled slip is never counted.
 * The trip row is locked (FOR UPDATE) for every add / cancel, like voucher generation, so a slip can never slip in
 * while a voucher is being made, and the voucher's Load always equals its slips.
 */
import { query, one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';

const MANAGERS = ['manager', 'admin', 'super_admin'];
const isManager = (user) => MANAGERS.includes(user?.role);

let ready = false;
let checkedAt = 0;
/** True once the load slip table exists (migration 2026-11-24 run). Checked at most once a minute until then. */
export async function loadSlipsReady(client) {
  if (ready) return true;
  if (Date.now() - checkedAt < 60_000) return false;
  checkedAt = Date.now();
  const r = await one(`SELECT to_regclass('public.load_slips') IS NOT NULL AS ok`, [], client);
  ready = Boolean(r?.ok);
  return ready;
}
/** For tests. */
export const resetLoadSlipsReady = () => {
  ready = false;
  checkedAt = 0;
};

const NOT_READY = () => new AppError(503, 'Extra load slips are not set up yet (database update pending). Ask an admin.', 'NOT_READY');

const SLIP = `
  SELECT ls.id, ls.slip_no, ls.booking_id, ls.trip_id, ls.stop_id, ls.taken_by, ls.terminal_id, ls.amount, ls.pieces,
         ls.weight_kg, ls.note, ls.status, ls.voucher_id, v.voucher_no, ls.created_by_name, ls.created_at,
         ls.cancelled_at, ls.cancelled_by_name, ls.cancel_reason, c.name AS stop_city, bk.pnr, bk.contact_name
  FROM load_slips ls
  JOIN bookings bk ON bk.id = ls.booking_id
  JOIN route_stops rs ON rs.id = ls.stop_id
  JOIN terminals tm ON tm.id = rs.terminal_id
  JOIN cities c ON c.id = tm.city_id
  LEFT JOIN trip_vouchers v ON v.id = ls.voucher_id`;

const shape = (s) => ({ ...s, weightKg: s.weightKg === null ? null : Number(s.weightKg) });

/** Every slip of a booking (newest last), cancelled ones included. [] before the migration. */
export async function slipsOfBooking(bookingId, client) {
  if (!(await loadSlipsReady(client))) return [];
  const { rows } = await query(`${SLIP} WHERE ls.booking_id = $1 ORDER BY ls.created_at, ls.id`, [bookingId], client);
  return rows.map(shape);
}

/** Active slips of a trip, by booking id (the conductor's screen). */
export async function slipsOfTrip(tripId, client) {
  if (!(await loadSlipsReady(client))) return new Map();
  const { rows } = await query(`${SLIP} WHERE ls.trip_id = $1 AND ls.status = 'active' ORDER BY ls.created_at, ls.id`, [tripId], client);
  const byBooking = new Map();
  for (const s of rows.map(shape)) byBooking.set(s.bookingId, [...(byBooking.get(s.bookingId) ?? []), s]);
  return byBooking;
}

/**
 * The counter slips a terminal's voucher takes: still open (voucherId null) for the preview, or the ones frozen on
 * that voucher. { count, total, slips }. null before the migration.
 */
export async function counterSlips(client, { tripId, stopId, voucherId = null }) {
  if (!(await loadSlipsReady(client))) return null;
  const { rows } = voucherId
    ? await query(`${SLIP} WHERE ls.voucher_id = $1 AND ls.status = 'active' ORDER BY ls.created_at, ls.id`, [voucherId], client)
    : await query(
        `${SLIP} WHERE ls.trip_id = $1 AND ls.stop_id = $2 AND ls.taken_by = 'counter' AND ls.status = 'active' AND ls.voucher_id IS NULL
         ORDER BY ls.created_at, ls.id`,
        [tripId, stopId],
        client,
      );
  const slips = rows.map(shape);
  return { count: slips.length, total: slips.reduce((t, s) => t + s.amount, 0), slips };
}

/** Voucher generation: the open counter slips are frozen on the new voucher. Returns { count, total }. */
export async function attachSlipsToVoucher(client, { tripId, stopId, voucherId }) {
  if (!(await loadSlipsReady(client))) return { count: 0, total: 0 };
  const { rows } = await query(
    `UPDATE load_slips SET voucher_id = $3
     WHERE trip_id = $1 AND stop_id = $2 AND taken_by = 'counter' AND status = 'active' AND voucher_id IS NULL
     RETURNING amount`,
    [tripId, stopId, voucherId],
    client,
  );
  return { count: rows.length, total: rows.reduce((t, r) => t + r.amount, 0) };
}

/** Bus swap: the replaced voucher's slips belong to its replacement. */
export async function moveSlipsToVoucher(client, { oldVoucherId, newVoucherId }) {
  if (!(await loadSlipsReady(client))) return;
  await client.query(`UPDATE load_slips SET voucher_id = $2 WHERE voucher_id = $1`, [oldVoucherId, newVoucherId]);
}

/** Round trip report: what the conductor took on the road after this terminal (active slips). */
export async function conductorLoadAt(client, { tripId, stopId }) {
  if (!(await loadSlipsReady(client))) return 0;
  const r = await one(
    `SELECT COALESCE(sum(amount), 0)::int AS total FROM load_slips
     WHERE trip_id = $1 AND stop_id = $2 AND taken_by = 'conductor' AND status = 'active'`,
    [tripId, stopId],
    client,
  );
  return r.total;
}

/* ------------------------------------------------------------------ finding the booking */

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** What was typed or scanned: the ticket's QR link, a ticket number, a booking reference or a slip number. */
export function bookingRefFrom(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const token = /\/t\/([0-9a-f-]{36})/i.exec(t)?.[1] ?? (UUID.test(t) && t.length === 36 ? t : null);
  if (token) return { token: token.toLowerCase() };
  const u = t.toUpperCase().replace(/\s+/g, '');
  if (/^LD-?\d{1,9}$/.test(u)) return { slipNo: `LD-${u.replace(/\D/g, '').padStart(6, '0')}` };
  if (/^NK-?\d{8}-?\d{1,9}$/.test(u)) {
    const [, d, n] = /^NK-?(\d{8})-?(\d+)$/.exec(u);
    return { ticketNo: `NK-${d}-${n.padStart(6, '0')}` };
  }
  if (/^NK[A-Z0-9]{6}$/.test(u)) return { pnr: u };
  return null;
}

async function bookingIdFrom(ref, client) {
  if (ref.pnr) return (await one(`SELECT id FROM bookings WHERE pnr = $1`, [ref.pnr], client))?.id;
  if (ref.ticketNo) return (await one(`SELECT booking_id FROM tickets WHERE ticket_no = $1`, [ref.ticketNo], client))?.bookingId;
  if (ref.slipNo) return (await one(`SELECT booking_id FROM load_slips WHERE slip_no = $1`, [ref.slipNo], client))?.bookingId;
  if (ref.token) {
    const has = await one(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'ticket_token') AS ok`,
      [],
      client,
    );
    if (!has.ok) return null;
    return (await one(`SELECT id FROM bookings WHERE ticket_token = $1::uuid`, [ref.token], client))?.id;
  }
  return null;
}

/** The booking with what the counter needs to see, its slips, and whether this user can add a slip now. */
async function bookingView(bookingId, user, client) {
  const b = await one(
    `SELECT bk.id, bk.pnr, bk.status::text AS status, bk.channel::text AS channel, bk.contact_name, bk.contact_phone,
            bk.trip_id, bk.boarding_stop_id, t.status::text AS trip_status, r.name AS route_name,
            bu.registration_no AS bus_no, bu.fleet_no,
            t.departure_at + make_interval(mins => bs.minutes_from_origin) AS boarding_at,
            bs.terminal_id AS boarding_terminal_id, bc.name AS boarding_city, dc.name AS dropping_city,
            EXISTS (SELECT 1 FROM trip_vouchers v WHERE v.trip_id = bk.trip_id AND v.boarding_stop_id = bk.boarding_stop_id
                    AND v.status = 'generated') AS voucher_done
     FROM bookings bk
     JOIN trips t ON t.id = bk.trip_id
     JOIN routes r ON r.id = t.route_id
     JOIN buses bu ON bu.id = t.bus_id
     JOIN route_stops bs ON bs.id = bk.boarding_stop_id
     JOIN terminals bt ON bt.id = bs.terminal_id JOIN cities bc ON bc.id = bt.city_id
     JOIN route_stops ds ON ds.id = bk.dropping_stop_id
     JOIN terminals dtm ON dtm.id = ds.terminal_id JOIN cities dc ON dc.id = dtm.city_id
     WHERE bk.id = $1`,
    [bookingId],
    client,
  );
  if (!b) return null;
  const { rows: passengers } = await query(
    `SELECT ls.seat_number AS seat, tk.passenger_name AS name, tk.status::text AS status
     FROM tickets tk JOIN layout_seats ls ON ls.id = tk.seat_id WHERE tk.booking_id = $1 ORDER BY tk.created_at`,
    [bookingId],
    client,
  );
  const why = counterBlock(b, user);
  return {
    bookingId: b.id,
    pnr: b.pnr,
    status: b.status,
    channel: b.channel,
    contactName: b.contactName,
    contactPhone: b.contactPhone,
    tripId: b.tripId,
    tripStatus: b.tripStatus,
    routeName: b.routeName,
    busNo: b.fleetNo ? `${b.fleetNo} · ${b.busNo}` : b.busNo,
    boardingAt: b.boardingAt,
    boardingStopId: b.boardingStopId,
    boardingCity: b.boardingCity,
    droppingCity: b.droppingCity,
    passengers,
    slips: await slipsOfBooking(bookingId, client),
    canAdd: !why,
    whyNot: why,
  };
}

/** Why the counter cannot add a slip to this booking now (null = it can). */
function counterBlock(b, user) {
  if (b.status !== 'confirmed') {
    return b.status === 'pending' ? 'This booking is not paid yet. Take the fare first.' : `This booking is ${b.status}.`;
  }
  if (['cancelled', 'arrived'].includes(b.tripStatus)) return `This trip is ${b.tripStatus}.`;
  if (!isManager(user)) {
    if (user.role !== 'agent') return 'Only counter staff or a manager can add extra load at the counter.';
    if (!user.terminalId) return 'Your account has no terminal. Ask an admin to set one.';
    if (user.terminalId !== b.boardingTerminalId) return `This passenger boards at ${b.boardingCity}: extra load is taken at that counter.`;
  }
  if (b.voucherDone) return `The voucher for ${b.boardingCity} is already generated (the bus has left). The conductor can add the load on the bus.`;
  return null;
}

/** Counter: find the booking from what was typed or scanned. */
export async function findBooking(text, user, client) {
  if (!(await loadSlipsReady(client))) throw NOT_READY();
  const ref = bookingRefFrom(text);
  if (!ref) throw AppError.badRequest('Type the booking reference (NK…), the ticket number (NK-…-…), or scan the ticket.', [{ field: 'q', message: 'Not a booking reference or ticket number.' }]);
  const id = await bookingIdFrom(ref, client);
  if (!id) throw AppError.notFound('No booking found with that reference or ticket number.');
  return bookingView(id, user, client);
}

/* ------------------------------------------------------------------ adding */

const clean = (d) => ({
  amount: d.amount,
  pieces: d.pieces ?? null,
  weightKg: d.weightKg ?? null,
  note: d.note ? String(d.note).trim().slice(0, 200) || null : null,
});

async function insertSlip(client, s) {
  return one(
    `INSERT INTO load_slips (slip_no, booking_id, trip_id, stop_id, taken_by, terminal_id, amount, pieces, weight_kg, note, created_by, created_by_name)
     VALUES ('LD-000000', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, slip_no`,
    [s.bookingId, s.tripId, s.stopId, s.takenBy, s.terminalId, s.amount, s.pieces, s.weightKg, s.note, s.userId ?? null, s.userName],
    client,
  );
}
const who = (user) => user.fullName || user.email || 'Staff';

/** Counter: a slip on a paid booking boarding at this terminal, before its voucher. Returns { slip, booking }. */
export async function addCounterSlip(client, { bookingId, user, ...data }) {
  if (!(await loadSlipsReady(client))) throw NOT_READY();
  const bk = await one(`SELECT trip_id FROM bookings WHERE id = $1`, [bookingId], client);
  if (!bk) throw AppError.notFound('Booking not found');
  // Same lock as voucher generation: the voucher sees this slip, or the slip sees the voucher.
  await client.query(`SELECT id FROM trips WHERE id = $1 FOR UPDATE`, [bk.tripId]);
  const view = await bookingView(bookingId, user, client);
  if (!view.canAdd) throw AppError.unprocessable(view.whyNot);
  const stop = await one(`SELECT terminal_id FROM route_stops WHERE id = $1`, [view.boardingStopId], client);
  const made = await insertSlip(client, {
    ...clean(data), bookingId, tripId: view.tripId, stopId: view.boardingStopId, takenBy: 'counter', terminalId: stop.terminalId,
    userId: user.id, userName: who(user),
  });
  return { slip: await getSlip(made.id, client), booking: view };
}

/** The last terminal whose voucher is generated (where the bus is now / has left from). */
async function lastLeftStop(client, tripId, routeId) {
  return one(
    `SELECT rs.id, rs.terminal_id FROM route_stops rs
     WHERE rs.route_id = $2 AND EXISTS (SELECT 1 FROM trip_vouchers v WHERE v.trip_id = $1 AND v.boarding_stop_id = rs.id AND v.status = 'generated')
     ORDER BY rs.stop_order DESC LIMIT 1`,
    [tripId, routeId],
    client,
  );
}

/** May this user work on this trip as its conductor? (the trip's conductor, its stand-in, or a manager) */
async function assertConductorOf(client, tripId, user) {
  const t = await one(
    `SELECT t.id, t.status::text AS status, t.route_id, t.stand_in_conductor_id, cn.user_id AS conductor_user_id
     FROM trips t LEFT JOIN conductors cn ON cn.id = t.conductor_id WHERE t.id = $1`,
    [tripId],
    client,
  );
  if (!t) throw AppError.notFound('Trip not found');
  if (!isManager(user) && t.conductorUserId !== user.id && t.standInConductorId !== user.id) {
    throw AppError.forbidden('This trip has another conductor.');
  }
  return t;
}

/** Conductor: a slip on a passenger of his trip, after the bus has left its first terminal and before it arrives. */
export async function addConductorSlip(client, { ticketId, user, ...data }) {
  if (!(await loadSlipsReady(client))) throw NOT_READY();
  const tk = await one(
    `SELECT tk.trip_id, tk.booking_id, tk.status::text AS ticket_status, bk.status::text AS booking_status
     FROM tickets tk JOIN bookings bk ON bk.id = tk.booking_id WHERE tk.id = $1`,
    [ticketId],
    client,
  );
  if (!tk) throw AppError.notFound('Passenger not found');
  await client.query(`SELECT id FROM trips WHERE id = $1 FOR UPDATE`, [tk.tripId]);
  const t = await assertConductorOf(client, tk.tripId, user);
  if (['cancelled', 'arrived'].includes(t.status)) throw AppError.unprocessable(`This trip is ${t.status}.`);
  if (!['confirmed', 'boarded'].includes(tk.ticketStatus) || tk.bookingStatus !== 'confirmed') {
    throw AppError.unprocessable('This passenger has no paid ticket on the bus.');
  }
  const stage = await lastLeftStop(client, tk.tripId, t.routeId);
  if (!stage) throw AppError.unprocessable('Extra load is added on the bus once the first terminal has generated its voucher. Before that, the counter adds it.');
  const made = await insertSlip(client, {
    ...clean(data), bookingId: tk.bookingId, tripId: tk.tripId, stopId: stage.id, takenBy: 'conductor', terminalId: stage.terminalId,
    userId: user.id, userName: who(user),
  });
  return getSlip(made.id, client);
}

/* ------------------------------------------------------------------ cancelling */

/** Cancels a slip (reason required). See the rules at the top. Returns the slip. */
export async function cancelSlip(client, { slipId, reason, user }) {
  if (!(await loadSlipsReady(client))) throw NOT_READY();
  const peek = await one(`SELECT trip_id FROM load_slips WHERE id = $1`, [slipId], client);
  if (!peek) throw AppError.notFound('Load slip not found');
  await client.query(`SELECT id FROM trips WHERE id = $1 FOR UPDATE`, [peek.tripId]);
  const s = await one(
    `SELECT ls.*, t.status::text AS trip_status FROM load_slips ls JOIN trips t ON t.id = ls.trip_id WHERE ls.id = $1 FOR UPDATE OF ls`,
    [slipId],
    client,
  );
  if (s.status !== 'active') throw AppError.conflict(`${s.slipNo} is already cancelled.`);
  if (!isManager(user)) {
    if (s.takenBy === 'counter') {
      if (user.role !== 'agent' || !user.terminalId || user.terminalId !== s.terminalId) {
        throw AppError.forbidden('Only the counter staff of that terminal (or a manager) can cancel this slip.');
      }
      if (s.voucherId) throw AppError.forbidden(`${s.slipNo} is already on the terminal voucher. Ask a manager.`);
    } else {
      await assertConductorOf(client, s.tripId, user);
      if (['arrived', 'cancelled'].includes(s.tripStatus)) throw AppError.forbidden(`The trip has ${s.tripStatus === 'arrived' ? 'arrived' : 'been cancelled'}. Ask a manager.`);
    }
  }
  await client.query(
    `UPDATE load_slips SET status = 'cancelled', cancelled_at = now(), cancelled_by_name = $2, cancel_reason = $3 WHERE id = $1`,
    [slipId, who(user), String(reason).trim().slice(0, 300)],
  );
  return getSlip(slipId, client);
}

/* ------------------------------------------------------------------ one slip (screen and print) */

export async function getSlip(id, client) {
  const s = await one(`${SLIP} WHERE ls.id = $1`, [id], client);
  return s ? shape(s) : null;
}

/** Everything the printed slip shows. Conductors only for their own trips. */
export async function slipForPrint(id, user, client) {
  if (!(await loadSlipsReady(client))) throw NOT_READY();
  const s = await getSlip(id, client);
  if (!s) throw AppError.notFound('Load slip not found');
  if (user.role === 'conductor') await assertConductorOf(client, s.tripId, user);
  const b = await one(
    `SELECT bk.id, bk.pnr, bk.status::text AS status, bk.contact_name, r.name AS route_name, bu.registration_no AS bus_no, bu.fleet_no,
            t.departure_at + make_interval(mins => bs.minutes_from_origin) AS boarding_at,
            bc.name AS boarding_city, dc.name AS dropping_city
     FROM bookings bk
     JOIN trips t ON t.id = bk.trip_id JOIN routes r ON r.id = t.route_id JOIN buses bu ON bu.id = t.bus_id
     JOIN route_stops bs ON bs.id = bk.boarding_stop_id JOIN terminals bt ON bt.id = bs.terminal_id JOIN cities bc ON bc.id = bt.city_id
     JOIN route_stops ds ON ds.id = bk.dropping_stop_id JOIN terminals dtm ON dtm.id = ds.terminal_id JOIN cities dc ON dc.id = dtm.city_id
     WHERE bk.id = $1`,
    [s.bookingId],
    client,
  );
  const { rows: names } = await query(
    `SELECT tk.passenger_name AS name, ls.seat_number AS seat FROM tickets tk JOIN layout_seats ls ON ls.id = tk.seat_id
     WHERE tk.booking_id = $1 AND tk.status IN ('confirmed', 'boarded') ORDER BY tk.created_at`,
    [s.bookingId],
    client,
  );
  return {
    ...s,
    pnr: b.pnr,
    bookingStatus: b.status,
    contactName: b.contactName,
    routeName: b.routeName,
    busNo: b.fleetNo ? `${b.fleetNo} · ${b.busNo}` : b.busNo,
    boardingAt: b.boardingAt,
    boardingCity: b.boardingCity,
    droppingCity: b.droppingCity,
    passengers: names,
  };
}
