/**
 * Terminal vouchers made at each terminal (meeting notes, 2026-11):
 *  - Counter staff press "Generate voucher" at their terminal. The voucher gets a 10-digit number from the
 *    company-wide series (next_voucher_no, shared with the report vouchers) and is frozen from then on.
 *  - It lists the PAID passengers boarding at that terminal by destination, how many are on the bus after the
 *    terminal (and how many travel free), the money: terminal cash (paid in cash at the counter), online paid
 *    (not in the conductor's hand), load, cargo, the terminal's fixed deductions, and the cash handed to the
 *    conductor (= terminal cash + load + cargo − deductions).
 *  - Generating it closes booking from that terminal (search and createBooking check trip_vouchers).
 *  - A replacement (bus swap) is issued only by a manager or admin, with a reason: new number, same details,
 *    the trip's current bus. A cancelled trip voids its vouchers.
 */
import { query, one } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { qrSvg } from '../roundtrips/roundtrips.service.js';

/** Paid seats: a ticket is only confirmed once its booking is paid; boarded and no-show were paid too. */
export const PAID = `('confirmed', 'boarded', 'no_show')`;

export const voucherUrl = (tripId, voucherNo) =>
  `${(env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/admin/trip-vouchers/${tripId}?voucher=${voucherNo}`;

/** Runs queries one after another on a transaction's connection, or in parallel on the pool. */
async function runAll(client, fns) {
  if (!client) return Promise.all(fns.map((f) => f()));
  const out = [];
  for (const f of fns) out.push(await f());
  return out;
}

export async function loadTrip(id, client) {
  const trip = await one(
    `SELECT t.id, t.status, t.departure_at, t.arrival_at, t.hostess_name, t.route_id, t.bus_id,
            t.conductor_id, t.stand_in_conductor_id,
            r.code AS route_code, r.name AS route_name,
            b.registration_no, b.fleet_no, b.bus_class, b.layout_id, l.total_seats,
            d.full_name AS driver_name, cn.full_name AS conductor_name, cn.user_id AS conductor_user_id,
            si.full_name AS stand_in_conductor_name
     FROM trips t
     JOIN routes r ON r.id = t.route_id
     JOIN buses b ON b.id = t.bus_id
     JOIN seat_layouts l ON l.id = b.layout_id
     LEFT JOIN drivers d ON d.id = t.driver_id
     LEFT JOIN conductors cn ON cn.id = t.conductor_id
     LEFT JOIN users si ON si.id = t.stand_in_conductor_id
     WHERE t.id = $1`,
    [id],
    client,
  );
  if (!trip) return null;
  const { rows: stops } = await query(
    `SELECT rs.id, rs.stop_order, rs.terminal_id, rs.is_boarding_point, rs.is_dropping_point,
            c.name AS city, tm.name AS terminal,
            $2::timestamptz + make_interval(mins => rs.minutes_from_origin) AS time
     FROM route_stops rs JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
     WHERE rs.route_id = $1 ORDER BY rs.stop_order`,
    [trip.routeId, trip.departureAt],
    client,
  );
  return { trip, stops };
}

/** The trip's paid passengers with where they board and get off, and how they paid. */
export async function paidPassengers(tripId, client) {
  const { rows } = await query(
    `SELECT tk.id AS ticket_id, tk.ticket_no, ls.id AS seat_id, ls.seat_number, ls.row_no, ls.col_no,
            tk.passenger_name, tk.passenger_gender, tk.passenger_phone, tk.fare_amount, tk.status,
            tk.is_free, tk.no_show_note,
            bk.pnr, bk.channel::text AS channel, bk.boarding_stop_id, bk.dropping_stop_id,
            (SELECT p.method::text FROM payments p WHERE p.booking_id = bk.id AND p.status = 'succeeded'
             ORDER BY p.paid_at DESC NULLS LAST LIMIT 1) AS paid_by,
            GREATEST(tk.updated_at, bk.updated_at) AS changed_at
     FROM tickets tk
     JOIN bookings bk ON bk.id = tk.booking_id
     JOIN layout_seats ls ON ls.id = tk.seat_id
     WHERE tk.trip_id = $1 AND tk.status IN ${PAID}
     ORDER BY ls.row_no, ls.col_no`,
    [tripId],
    client,
  );
  return rows;
}

/** Fixed deductions of a terminal (amounts above 0), in list order. */
export async function terminalDeductions(terminalId, client) {
  const { rows } = await query(
    `SELECT d.category_id, c.name, d.amount FROM terminal_deductions d JOIN onroute_categories c ON c.id = d.category_id
     WHERE d.terminal_id = $1 AND d.amount > 0 ORDER BY c.sort_order, c.name`,
    [terminalId],
    client,
  );
  return rows;
}

const fareOf = (p) => (p.isFree ? 0 : Math.round(Number(p.fareAmount) || 0));

/** Everything a voucher for `stop` would show right now. */
export function buildSnapshot({ stops, passengers, stop, deductions, loadAmount = 0, cargoAmount = 0 }) {
  const order = (sid) => stops.find((s) => s.id === sid)?.stopOrder ?? 999;
  const cityOf = (sid) => stops.find((s) => s.id === sid)?.city ?? '?';
  const boarding = passengers.filter((p) => p.boardingStopId === stop.id && p.status !== 'no_show');

  const lines = new Map();
  for (const p of boarding) {
    const l = lines.get(p.droppingStopId) ?? { destinationStopId: p.droppingStopId, destination: cityOf(p.droppingStopId), seats: 0, freeSeats: 0, fare: 0 };
    l.seats += 1;
    if (p.isFree) l.freeSeats += 1;
    l.fare += fareOf(p);
    lines.set(p.droppingStopId, l);
  }
  const sortedLines = [...lines.values()].sort((a, b) => order(a.destinationStopId) - order(b.destinationStopId));

  // On the bus after this terminal: got on here or earlier, and gets off later.
  const onBoard = passengers.filter(
    (p) => p.status !== 'no_show' && order(p.boardingStopId) <= stop.stopOrder && order(p.droppingStopId) > stop.stopOrder,
  );
  const cash = boarding.filter((p) => p.paidBy === 'cash').reduce((s, p) => s + fareOf(p), 0);
  const online = boarding.filter((p) => p.paidBy && p.paidBy !== 'cash').reduce((s, p) => s + fareOf(p), 0);
  const deductionsTotal = deductions.reduce((s, d) => s + d.amount, 0);

  return {
    lines: sortedLines,
    seatsBoarding: boarding.length,
    fareBoarding: boarding.reduce((s, p) => s + fareOf(p), 0),
    onBoard: onBoard.length,
    freeOnBoard: onBoard.filter((p) => p.isFree).length,
    terminalCash: cash,
    onlinePaid: online,
    loadAmount,
    cargoAmount,
    deductions: deductions.map((d) => ({ categoryId: d.categoryId, name: d.name, amount: d.amount })),
    deductionsTotal,
    cashToConductor: cash + loadAmount + cargoAmount - deductionsTotal,
    passengers: boarding.map((p) => ({
      ticketId: p.ticketId, seat: p.seatNumber, name: p.passengerName, gender: p.passengerGender,
      destination: cityOf(p.droppingStopId), fare: fareOf(p), paidBy: p.paidBy, isFree: p.isFree,
    })),
  };
}

/** Terminals a voucher can be made at: boarding points, except the last stop. */
export const voucherStops = (stops) => stops.filter((s, i) => s.isBoardingPoint && i < stops.length - 1);

/** Counter staff only at their own terminal; managers and admins anywhere. */
export function canGenerateAt(user, stop) {
  if (['manager', 'admin', 'super_admin'].includes(user.role)) return true;
  return user.role === 'agent' && Boolean(user.terminalId) && user.terminalId === stop.terminalId;
}

async function insertVoucher(client, v) {
  const row = await one(
    `INSERT INTO trip_vouchers (voucher_no, trip_id, boarding_stop_id, terminal_id, terminal_name, route_name, bus_id, bus_no,
                                driver_name, conductor_name, departure_at, seats_boarding, fare_boarding, on_board, free_on_board,
                                terminal_cash, online_paid, load_amount, cargo_amount, deductions_total, cash_to_conductor,
                                generated_by, generated_by_name, replaces_id, replace_reason, approved_by, approved_by_name)
     VALUES ('0000000000', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
             $21, $22, $23, $24, $25, $26)
     RETURNING id, voucher_no`,
    [v.tripId, v.boardingStopId, v.terminalId, v.terminalName, v.routeName, v.busId, v.busNo, v.driverName, v.conductorName,
      v.departureAt, v.seatsBoarding, v.fareBoarding, v.onBoard, v.freeOnBoard, v.terminalCash, v.onlinePaid, v.loadAmount,
      v.cargoAmount, v.deductionsTotal, v.cashToConductor, v.generatedBy, v.generatedByName, v.replacesId ?? null,
      v.replaceReason ?? null, v.approvedBy ?? null, v.approvedByName ?? null],
    client,
  );
  for (const [i, l] of v.lines.entries()) {
    await client.query(
      `INSERT INTO trip_voucher_lines (voucher_id, destination_stop_id, destination, seats, free_seats, fare, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.id, l.destinationStopId, l.destination, l.seats, l.freeSeats, l.fare, i + 1],
    );
  }
  for (const d of v.deductions) {
    await client.query(
      `INSERT INTO trip_voucher_deductions (voucher_id, category_id, name, amount) VALUES ($1, $2, $3, $4)`,
      [row.id, d.categoryId ?? null, d.name, d.amount],
    );
  }
  for (const p of v.passengers) {
    await client.query(
      `INSERT INTO trip_voucher_passengers (voucher_id, ticket_id, seat_number, name, gender, destination, fare, paid_by, is_free)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id, p.ticketId ?? null, p.seat, p.name, p.gender ?? null, p.destination, p.fare, p.paidBy ?? null, Boolean(p.isFree)],
    );
  }
  return row;
}

/** Generates the voucher of one terminal. Locks the trip so no booking slips in while it is made. */
export async function generateVoucher(client, { tripId, boardingStopId, loadAmount, cargoAmount, user }) {
  const lock = await one(`SELECT id, status FROM trips WHERE id = $1 FOR UPDATE`, [tripId], client);
  if (!lock) throw AppError.notFound('Trip not found');
  if (['cancelled', 'arrived'].includes(lock.status)) throw AppError.unprocessable(`This trip is ${lock.status}.`);

  const { trip, stops } = await loadTrip(tripId, client);
  const stop = voucherStops(stops).find((s) => s.id === boardingStopId);
  if (!stop) throw AppError.badRequest('That terminal is not a boarding point of this trip.');
  if (!canGenerateAt(user, stop)) {
    throw AppError.forbidden(user.terminalId ? 'You can only generate vouchers at your own terminal.' : 'Your account has no terminal. Ask an admin to set one.');
  }
  if (!trip.conductorId && !trip.standInConductorId) {
    throw AppError.unprocessable('Assign a conductor to this trip first. The bus cannot leave without one.');
  }
  const existing = await one(
    `SELECT voucher_no FROM trip_vouchers WHERE trip_id = $1 AND boarding_stop_id = $2 AND status = 'generated'`,
    [tripId, boardingStopId],
    client,
  );
  if (existing) throw AppError.conflict(`The voucher for this terminal is already generated (no. ${existing.voucherNo}).`);

  const passengers = await paidPassengers(tripId, client);
  const deductions = await terminalDeductions(stop.terminalId, client);
  const snap = buildSnapshot({ stops, passengers, stop, deductions, loadAmount, cargoAmount });
  return insertVoucher(client, {
    ...snap,
    tripId,
    boardingStopId,
    terminalId: stop.terminalId,
    terminalName: stop.city,
    routeName: trip.routeName,
    busId: trip.busId,
    busNo: trip.registrationNo,
    driverName: trip.driverName,
    conductorName: trip.conductorName ?? trip.standInConductorName,
    departureAt: stop.time,
    generatedBy: user.id,
    generatedByName: user.fullName || user.email || 'Staff',
  });
}

/** Bus swap: the voucher is replaced by a new one with the same details and the trip's current bus. */
export async function replaceVoucher(client, { voucherId, reason, user }) {
  const old = await one(`SELECT * FROM trip_vouchers WHERE id = $1 FOR UPDATE`, [voucherId], client);
  if (!old) throw AppError.notFound('Voucher not found');
  if (old.status !== 'generated') throw AppError.conflict(`This voucher is ${old.status} and cannot be replaced.`);
  const { trip } = await loadTrip(old.tripId, client);
  const [lines, deductions, passengers] = await runAll(client, [
    () => query(`SELECT destination_stop_id, destination, seats, free_seats, fare FROM trip_voucher_lines WHERE voucher_id = $1 ORDER BY sort_order`, [old.id], client),
    () => query(`SELECT category_id, name, amount FROM trip_voucher_deductions WHERE voucher_id = $1 ORDER BY id`, [old.id], client),
    () => query(`SELECT ticket_id, seat_number AS seat, name, gender, destination, fare, paid_by, is_free FROM trip_voucher_passengers WHERE voucher_id = $1 ORDER BY id`, [old.id], client),
  ]);
  await client.query(
    `UPDATE trip_vouchers SET status = 'replaced', closed_at = now(), closed_reason = $2 WHERE id = $1`,
    [old.id, reason],
  );
  const who = user.fullName || user.email || 'Staff';
  const fresh = await insertVoucher(client, {
    ...old,
    busId: trip.busId,
    busNo: trip.registrationNo,
    driverName: trip.driverName ?? old.driverName,
    conductorName: trip.conductorName ?? trip.standInConductorName ?? old.conductorName,
    lines: lines.rows,
    deductions: deductions.rows,
    passengers: passengers.rows,
    generatedBy: user.id,
    generatedByName: who,
    replacesId: old.id,
    replaceReason: reason,
    approvedBy: user.id,
    approvedByName: who,
  });
  return { old, fresh };
}

/** One voucher as printed, with its lines, deductions, passengers and QR code. */
export async function loadVoucher(voucherId) {
  const v = await one(
    `SELECT v.*, r.id AS replaced_by_id, r.voucher_no AS replaced_by_no, o.voucher_no AS replaces_no
     FROM trip_vouchers v
     LEFT JOIN trip_vouchers r ON r.replaces_id = v.id
     LEFT JOIN trip_vouchers o ON o.id = v.replaces_id
     WHERE v.id = $1`,
    [voucherId],
  );
  if (!v) return null;
  const [lines, deductions, passengers] = await runAll(null, [
    () => query(`SELECT destination, seats, free_seats, fare FROM trip_voucher_lines WHERE voucher_id = $1 ORDER BY sort_order`, [v.id]),
    () => query(`SELECT name, amount FROM trip_voucher_deductions WHERE voucher_id = $1 ORDER BY id`, [v.id]),
    () => query(`SELECT seat_number AS seat, name, gender, destination, fare, paid_by, is_free FROM trip_voucher_passengers WHERE voucher_id = $1 ORDER BY id`, [v.id]),
  ]);
  const url = voucherUrl(v.tripId, v.voucherNo);
  return { ...v, lines: lines.rows, deductions: deductions.rows, passengers: passengers.rows, url, qrSvg: await qrSvg(url) };
}
