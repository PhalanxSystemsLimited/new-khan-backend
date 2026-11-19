/**
 * QR code on tickets (migration 2026-11-20-ticket-qr.sql).
 *
 * Each booking has ticket_token, a random UUID used only in the ticket's QR: <APP_URL>/t/<token>. Scanning it
 * opens the ticket check page, which asks GET /api/v1/tickets/check/:token:
 *  - anyone: whether the ticket is valid, the journey, and the seats with passenger names. Never the phone,
 *    CNIC, email or payment details.
 *  - New Khan staff who are signed in (counter, conductor, driver, manager, admin): also the contact phone,
 *    masked CNIC, how it was paid and whether each passenger has boarded.
 * The page only shows details; nothing can be changed from it.
 *
 * Until the migration runs there is no ticket_token column: tickets show no QR and the check page says
 * "not found". Nothing else is affected (ticketQrReady guards every query).
 */
import { query, one } from '../../config/db.js';
import { env } from '../../config/env.js';
import { isEmployee } from '../../middleware/auth.js';
import { cnicMasked } from '../../utils/cnic.js';
import { qrSvg } from '../roundtrips/roundtrips.service.js';
import { seatOrder } from '../../utils/seats.js';
import { confirmedSql } from '../trips/busConfirm.js';

let ready = false;
let checkedAt = 0;

/** Has the migration run? Checked once a minute until it has, then remembered. */
export async function ticketQrReady(client) {
  if (ready) return true;
  if (Date.now() - checkedAt < 60_000) return false;
  checkedAt = Date.now();
  const r = await one(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'bookings' AND column_name = 'ticket_token') AS ok`,
    [],
    client,
  );
  ready = Boolean(r?.ok);
  return ready;
}
/** For tests. */
export const resetTicketQrReady = () => {
  ready = false;
  checkedAt = 0;
};

export const ticketUrl = (token) => `${(env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/t/${token}`;

/** Bookings whose ticket gets a QR: paid ones (a confirmed booking, or a completed trip). */
const QR_STATUSES = ['confirmed', 'completed'];

/** { url, svg } for a booking's ticket, or null (not paid, or the migration has not run). */
export async function ticketQrFor(booking, client) {
  if (!booking || !QR_STATUSES.includes(booking.status)) return null;
  if (!(await ticketQrReady(client))) return null;
  const r = await one(`SELECT ticket_token FROM bookings WHERE id = $1`, [booking.id], client);
  if (!r?.ticketToken) return null;
  const url = ticketUrl(r.ticketToken);
  return { url, svg: await qrSvg(url) };
}

/**
 * What the check page shows at a glance:
 *  valid      paid, and the trip has not happened yet (or is on its way)
 *  completed  the trip has arrived / the booking is completed
 *  cancelled  the booking, or the whole trip, was cancelled (or refunded)
 *  unpaid     reserved but not paid
 *  expired    the reservation ran out before it was paid
 */
export function ticketState(bookingStatus, tripStatus) {
  if (['cancelled', 'refunded'].includes(bookingStatus) || tripStatus === 'cancelled') return 'cancelled';
  if (bookingStatus === 'expired') return 'expired';
  if (bookingStatus === 'pending') return 'unpaid';
  if (bookingStatus === 'completed' || tripStatus === 'arrived') return 'completed';
  return 'valid';
}

/** The check page's data for a scanned code, or null when no ticket has that code. */
export async function checkTicket(token, user, client) {
  if (!(await ticketQrReady(client))) return null;
  const confirmed = await confirmedSql('t', client);
  const b = await one(
    `SELECT bk.id, bk.pnr, bk.status, bk.channel, bk.contact_name, bk.contact_phone, bk.holder_cnic,
            bk.total_amount, bk.confirmed_at, bk.cancelled_at, ${confirmed} AS bus_confirmed,
            r.name AS route_name, t.id AS trip_id, t.status AS trip_status, b.bus_class,
            b.registration_no, b.fleet_no,
            bt.name AS boarding_terminal, dt.name AS dropping_terminal,
            t.departure_at + make_interval(mins => bs.minutes_from_origin) AS boarding_at,
            t.departure_at + make_interval(mins => ds.minutes_from_origin) AS dropping_at
     FROM bookings bk
     JOIN trips t        ON t.id = bk.trip_id
     JOIN routes r       ON r.id = t.route_id
     JOIN buses b        ON b.id = t.bus_id
     JOIN route_stops bs ON bs.id = bk.boarding_stop_id JOIN terminals bt ON bt.id = bs.terminal_id
     JOIN route_stops ds ON ds.id = bk.dropping_stop_id JOIN terminals dt ON dt.id = ds.terminal_id
     WHERE bk.ticket_token = $1`,
    [token],
    client,
  );
  if (!b) return null;
  const { rows: tickets } = await query(
    `SELECT ls.seat_number, tk.passenger_name, tk.status, tk.boarded_at
     FROM tickets tk JOIN layout_seats ls ON ls.id = tk.seat_id
     WHERE tk.booking_id = $1 ORDER BY ${seatOrder('ls')}`,
    [b.id],
    client,
  );

  const pub = {
    state: ticketState(b.status, b.tripStatus),
    pnr: b.pnr,
    routeName: b.routeName,
    boardingTerminal: b.boardingTerminal,
    droppingTerminal: b.droppingTerminal,
    boardingAt: b.boardingAt,
    droppingAt: b.droppingAt,
    busClass: b.busClass,
    seats: tickets.map((t) => ({ seat: t.seatNumber, name: t.passengerName, cancelled: t.status === 'cancelled' })),
    staff: false,
  };
  if (!isEmployee(user)) return pub;

  const { rows: payments } = await query(
    `SELECT method, amount FROM payments WHERE booking_id = $1 AND status IN ('succeeded', 'refunded', 'partially_refunded')`,
    [b.id],
    client,
  );
  return {
    ...pub,
    staff: true,
    bookingId: b.id,
    tripId: b.tripId,
    bus: `${b.fleetNo ? `${b.fleetNo} · ${b.registrationNo}` : b.registrationNo}${b.busConfirmed ? '' : ' (planned, to confirm)'}`,
    bookingStatus: b.status,
    tripStatus: b.tripStatus,
    channel: b.channel,
    contactName: b.contactName,
    contactPhone: b.contactPhone,
    holderCnicMasked: cnicMasked(b.holderCnic),
    totalAmount: b.totalAmount,
    paidAmount: payments.reduce((s, p) => s + Number(p.amount), 0),
    paidBy: [...new Set(payments.map((p) => p.method))],
    seats: tickets.map((t) => ({ seat: t.seatNumber, name: t.passengerName, status: t.status, boardedAt: t.boardedAt, cancelled: t.status === 'cancelled' })),
  };
}
