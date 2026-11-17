/**
 * Cargo at the destination (cargo stage 1 part 3): receiving parcels off the bus, handing them over, returns.
 *
 * Rules:
 *  - Staff of the DESTINATION terminal tick parcels off the arriving bus (by number / scan, or several at once):
 *    only parcels that are on a bus ("loaded") and addressed to this terminal. They become "arrived".
 *  - Handing over ("delivered"), only at the destination terminal, only once arrived. Always recorded: who took it,
 *    their CNIC, and the proof:
 *      receiver_cnic  the receiver with their own CNIC (must match the receiver's CNIC if it was given at booking)
 *      slip           someone with the slip or a picture of it, who gives their own CNIC
 *    A receiver-pays parcel is handed over only when the money is taken (it counts for this terminal, today).
 *  - Not collected: "returned" with a reason (it shows as overdue after the settings' overdue days).
 *  - Counter staff only at their own terminal; managers and admins at any.
 */
import { query, one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { addEvent, cargoSettings, isCargoManager } from './cargo.service.js';

const byName = (user) => user?.fullName || user?.email || 'Staff';
const rs = (n) => `Rs ${Number(n).toLocaleString('en-US')}`;
const maskCnic = (v) => String(v ?? '').replace(/^(\d{5})-?\d{7}-?(\d)$/, '$1-*******-$2');
const cnicDigits = (v) => String(v ?? '').replace(/\D/g, '');

/** The terminal this user works at for arrivals: counter staff their own; managers the one they choose. */
export function workTerminal(user, requested) {
  if (isCargoManager(user)) {
    const t = requested ?? user.terminalId;
    if (!t) throw AppError.badRequest('Choose a terminal.');
    return t;
  }
  if (!user.terminalId) throw AppError.forbidden('Your account has no terminal. Ask an admin to set one.');
  if (requested && requested !== user.terminalId) throw AppError.forbidden('You can only work with parcels at your own terminal.');
  return user.terminalId;
}

const COLS = `p.id, p.parcel_no, p.status, p.payment, p.paid_at, p.charge, p.pieces, p.weight_kg, p.description,
  p.sender_name, p.sender_phone, p.receiver_name, p.receiver_phone, p.receiver_cnic, p.arrived_at, p.arrived_by_name,
  p.delivered_at, p.collected_by_name, p.created_at, fc.name AS from_city, ft.name AS from_terminal`;

/**
 * The destination screen of a terminal: buses bringing parcels here (still to tick off, and those ticked off in the
 * last 12 hours), parcels waiting for collection (with days waiting and overdue), and today's hand-overs.
 */
export async function arrivalsView(client, { terminalId }) {
  const terminal = await one(
    `SELECT t.id, t.name, c.name AS city FROM terminals t JOIN cities c ON c.id = t.city_id WHERE t.id = $1`,
    [terminalId],
    client,
  );
  if (!terminal) throw AppError.notFound('Terminal not found');
  const settings = await cargoSettings(client);
  const { rows: onBuses } = await query(
    `SELECT ${COLS}, l.id AS list_id, l.list_no, COALESCE(l.bus_no, b.registration_no) AS bus, r.name AS route_name,
            lc.name AS list_city, t.status::text AS trip_status,
            t.departure_at + make_interval(mins => bs.minutes_from_origin + t.delay_minutes) AS left_at,
            t.departure_at + make_interval(mins => ds.minutes_from_origin + t.delay_minutes) AS due_at
     FROM parcels p
     JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
     JOIN cargo_lists l ON l.id = p.list_id
     JOIN trips t ON t.id = l.trip_id JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
     JOIN route_stops bs ON bs.id = l.boarding_stop_id
     LEFT JOIN terminals lt ON lt.id = l.terminal_id LEFT JOIN cities lc ON lc.id = lt.city_id
     LEFT JOIN route_stops ds ON ds.route_id = t.route_id AND ds.terminal_id = p.to_terminal_id
     WHERE p.to_terminal_id = $1
       AND (p.status = 'loaded' OR (p.status IN ('arrived', 'delivered') AND p.arrived_at > now() - interval '12 hours'))
     ORDER BY due_at NULLS LAST, l.list_no, p.parcel_no`,
    [terminalId],
    client,
  );
  // One entry per bus list: what to tick off and what is ticked off.
  const buses = [];
  for (const p of onBuses) {
    let g = buses.find((x) => x.listId === p.listId);
    if (!g) {
      g = { listId: p.listId, listNo: p.listNo, bus: p.bus, routeName: p.routeName, fromCity: p.listCity, tripStatus: p.tripStatus, leftAt: p.leftAt, dueAt: p.dueAt, parcels: [] };
      buses.push(g);
    }
    g.parcels.push(p);
  }
  for (const g of buses) {
    g.toReceive = g.parcels.filter((p) => p.status === 'loaded').length;
    g.received = g.parcels.length - g.toReceive;
    // Due here more than 2 hours ago and still not ticked off: look for it on the bus.
    g.late = g.toReceive > 0 && g.dueAt && new Date(g.dueAt).getTime() < Date.now() - 2 * 3_600_000;
  }
  const { rows: waiting } = await query(
    `SELECT ${COLS}, floor(EXTRACT(EPOCH FROM (now() - p.arrived_at)) / 86400)::int AS days_waiting
     FROM parcels p JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
     WHERE p.to_terminal_id = $1 AND p.status = 'arrived'
     ORDER BY p.arrived_at`,
    [terminalId],
    client,
  );
  for (const w of waiting) w.overdue = w.daysWaiting >= settings.overdueDays;
  const { rows: handedOver } = await query(
    `SELECT ${COLS}, p.collected_proof FROM parcels p JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
     WHERE p.delivered_terminal_id = $1 AND p.status = 'delivered'
       AND p.delivered_at >= (now() AT TIME ZONE 'Asia/Karachi')::date::timestamp AT TIME ZONE 'Asia/Karachi'
     ORDER BY p.delivered_at DESC`,
    [terminalId],
    client,
  );
  return {
    terminal,
    overdueDays: settings.overdueDays,
    buses: buses.filter((g) => g.toReceive > 0 || g.received > 0),
    waiting,
    handedOver,
    counts: {
      onTheWay: onBuses.filter((p) => p.status === 'loaded').length,
      waiting: waiting.length,
      overdue: waiting.filter((w) => w.overdue).length,
      toCollectCash: waiting.filter((w) => w.payment === 'to_pay' && !w.paidAt).reduce((s, w) => s + w.charge, 0),
    },
  };
}

const NOT_ON_BUS = {
  booked: (p) => `${p.parcelNo} is not on a bus yet: it is still at ${p.fromCity}.`,
  arrived: (p) => `${p.parcelNo} is already received here.`,
  delivered: (p) => `${p.parcelNo} is already handed over.`,
  returned: (p) => `${p.parcelNo} was returned to the sender.`,
  cancelled: (p) => `${p.parcelNo} was cancelled.`,
};

/** Ticks parcels off the arriving bus (by ids, or a typed / scanned number). Run inside a transaction; all or nothing. */
export async function receiveParcels(client, { terminalId, parcelIds = [], parcel, user }) {
  const here = workTerminal(user, terminalId);
  const ids = [...parcelIds];
  if (parcel) {
    const m = String(parcel).toUpperCase().match(/CG-?(\d{1,8})/);
    if (!m) throw AppError.badRequest('Type or scan a parcel number (CG-…).');
    const found = await one(`SELECT id FROM parcels WHERE parcel_no = $1`, [`CG-${m[1].padStart(7, '0')}`], client);
    if (!found) throw AppError.notFound(`No parcel CG-${m[1].padStart(7, '0')}.`);
    ids.push(found.id);
  }
  if (!ids.length) throw AppError.badRequest('Choose the parcels that came off the bus.');
  const done = [];
  for (const id of [...new Set(ids)]) {
    const p = await one(
      `SELECT p.id, p.parcel_no, p.status, p.to_terminal_id, p.list_id, fc.name AS from_city, tc.name AS to_city, tt.name AS to_terminal,
              l.list_no, COALESCE(l.bus_no, b.registration_no) AS bus
       FROM parcels p
       JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
       JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id
       LEFT JOIN cargo_lists l ON l.id = p.list_id LEFT JOIN trips t ON t.id = l.trip_id LEFT JOIN buses b ON b.id = t.bus_id
       WHERE p.id = $1 FOR UPDATE OF p`,
      [id],
      client,
    );
    if (!p) throw AppError.notFound('Parcel not found');
    if (p.toTerminalId !== here) throw AppError.unprocessable(`${p.parcelNo} goes to ${p.toCity} · ${p.toTerminal}, not here.`);
    if (p.status !== 'loaded') throw AppError.unprocessable((NOT_ON_BUS[p.status] ?? (() => `${p.parcelNo} is ${p.status}.`))(p));
    await client.query(`UPDATE parcels SET status = 'arrived', arrived_at = now(), arrived_by_name = $2 WHERE id = $1`, [p.id, byName(user)]);
    await addEvent(client, { parcelId: p.id, event: 'arrived', terminalId: here, user, note: `Received at ${p.toCity} · ${p.toTerminal} off bus ${p.bus ?? '–'}${p.listNo ? ` (cargo list ${p.listNo})` : ''}` });
    done.push(p.parcelNo);
  }
  return { received: done };
}

/** Hands a parcel over at its destination. Run inside a transaction. */
export async function deliverParcel(client, { id, proof, collectorName, collectorCnic, cashReceived, user }) {
  const p = await one(
    `SELECT p.id, p.parcel_no, p.status, p.to_terminal_id, p.payment, p.paid_at, p.charge, p.receiver_name, p.receiver_cnic,
            tc.name AS to_city, tt.name AS to_terminal
     FROM parcels p JOIN terminals tt ON tt.id = p.to_terminal_id JOIN cities tc ON tc.id = tt.city_id
     WHERE p.id = $1 FOR UPDATE OF p`,
    [id],
    client,
  );
  if (!p) throw AppError.notFound('Parcel not found');
  if (!isCargoManager(user) && user.terminalId !== p.toTerminalId) throw AppError.forbidden(`${p.parcelNo} is collected at ${p.toCity} · ${p.toTerminal}, not at your terminal.`);
  if (p.status !== 'arrived') {
    const why = { booked: 'has not left yet', loaded: 'is still on the bus: receive it off the bus first', delivered: 'is already handed over', returned: 'was returned to the sender', cancelled: 'was cancelled' }[p.status] ?? p.status;
    throw AppError.unprocessable(`${p.parcelNo} ${why}.`);
  }
  const field = (f, msg) => AppError.unprocessable(msg, [{ field: f, message: msg }]);
  if (proof === 'receiver_cnic' && p.receiverCnic && cnicDigits(p.receiverCnic) !== cnicDigits(collectorCnic)) {
    throw field('collectorCnic', `This CNIC does not match the receiver's CNIC on the booking (${maskCnic(p.receiverCnic)}). If someone else is collecting, they need the slip.`);
  }
  const owes = p.payment === 'to_pay' && !p.paidAt;
  if (owes && !cashReceived) throw field('cashReceived', `The receiver pays ${rs(p.charge)}: take the money first.`);

  await client.query(
    `UPDATE parcels SET status = 'delivered', delivered_at = now(), delivered_terminal_id = $2, collected_by_name = $3,
            collected_by_cnic = $4, collected_proof = $5, delivered_by = $6, delivered_by_name = $7,
            paid_at = CASE WHEN $8 THEN now() ELSE paid_at END, paid_terminal_id = CASE WHEN $8 THEN $2 ELSE paid_terminal_id END
     WHERE id = $1`,
    [p.id, p.toTerminalId, collectorName, collectorCnic, proof, user.id ?? null, byName(user), owes],
  );
  const how = proof === 'receiver_cnic' ? "receiver's own CNIC" : 'slip shown';
  await addEvent(client, {
    parcelId: p.id, event: 'delivered', terminalId: p.toTerminalId, user,
    note: `Handed over to ${collectorName} (CNIC ${maskCnic(collectorCnic)}, ${how})${owes ? `. ${rs(p.charge)} received` : ''}`,
  });
  return { id: p.id, parcelNo: p.parcelNo, cashTaken: owes ? p.charge : 0 };
}

/** Not collected: returned to the sender. Run inside a transaction. */
export async function returnParcel(client, { id, reason, user }) {
  const p = await one(
    `SELECT p.id, p.parcel_no, p.status, p.to_terminal_id, fc.name AS from_city
     FROM parcels p JOIN terminals ft ON ft.id = p.from_terminal_id JOIN cities fc ON fc.id = ft.city_id
     WHERE p.id = $1 FOR UPDATE OF p`,
    [id],
    client,
  );
  if (!p) throw AppError.notFound('Parcel not found');
  if (!isCargoManager(user) && user.terminalId !== p.toTerminalId) throw AppError.forbidden('Only the terminal holding the parcel (or a manager) can return it.');
  if (p.status !== 'arrived') throw AppError.unprocessable(`Only a parcel waiting for collection can be returned (${p.parcelNo} is ${p.status}).`);
  await client.query(`UPDATE parcels SET status = 'returned', returned_at = now(), returned_reason = $2 WHERE id = $1`, [p.id, reason]);
  await addEvent(client, { parcelId: p.id, event: 'returned', terminalId: p.toTerminalId, user, note: `${reason.replace(/[.\s]+$/, '')}. Back to the sender at ${p.fromCity}.` });
  return { id: p.id, parcelNo: p.parcelNo };
}

/** For the counter screen: parcels on the way here, waiting for collection, overdue. */
export async function arrivalCounts(client, terminalId) {
  const s = await cargoSettings(client);
  return one(
    `SELECT count(*) FILTER (WHERE status = 'loaded')::int AS on_the_way,
            count(*) FILTER (WHERE status = 'arrived')::int AS waiting,
            count(*) FILTER (WHERE status = 'arrived' AND arrived_at < now() - make_interval(days => $2))::int AS overdue
     FROM parcels WHERE to_terminal_id = $1 AND status IN ('loaded', 'arrived')`,
    [terminalId, s.overdueDays],
    client,
  );
}
