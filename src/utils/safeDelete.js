import { query } from '../config/db.js';
import { AppError } from './AppError.js';

/**
 * Delete only what nothing else uses.
 *
 * The admin panel's Delete buttons remove a record only while no other row points at it (a bus with no trips, a
 * terminal on no route...). A record that has been used keeps its history: tickets, payments, vouchers and reports
 * still need it, so the admin unticks "Active" instead.
 *
 * The check reads the database's own foreign keys, so a table added later is covered without changing this file.
 */

/** How each table that can point at a record is named in the message. */
const LABELS = {
  bookings: 'bookings',
  tickets: 'tickets',
  trips: 'trips',
  round_trips: 'round trip reports',
  round_trip_legs: 'round trip reports',
  schedules: 'schedules',
  trip_vouchers: 'terminal vouchers',
  trip_voucher_lines: 'terminal vouchers',
  terminal_vouchers: 'report vouchers',
  cargo_lists: 'cargo lists',
  load_slips: 'extra load slips',
  reviews: 'reviews',
  terminals: 'terminals',
  cargo_rates: 'cargo rates',
  routes: 'routes',
  route_stops: 'routes',
  fares: 'fares',
  promo_codes: 'promo codes',
  parcels: 'parcels',
  parcel_events: 'parcels',
  staff_directory: 'staff directory entries',
  terminal_deductions: 'terminal deduction amounts (report settings)',
  offroute_defaults: 'off-route amounts (report settings)',
  users: 'staff accounts',
  drivers: 'drivers',
  conductors: 'conductors',
};

const ident = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * What points at row `id` of `table`, as [{ table, label, count }] (only tables with at least one row).
 * `skip`: tables that are deleted together with the record (a route's own stops and fares).
 */
export async function usageOf(client, table, id, { skip = [] } = {}) {
  const { rows: links } = await query(
    `SELECT n.nspname AS schema, c.relname AS child, a.attname AS col
       FROM pg_constraint con
       JOIN pg_class c      ON c.oid = con.conrelid
       JOIN pg_namespace n  ON n.oid = c.relnamespace
       JOIN pg_attribute a  ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND con.confrelid = $1::regclass AND array_length(con.conkey, 1) = 1
      ORDER BY c.relname, a.attname`,
    [table],
    client,
  );
  const counts = new Map();
  for (const l of links) {
    if (skip.includes(l.child)) continue;
    const { rows } = await query(`SELECT count(*)::int AS n FROM ${ident(l.schema)}.${ident(l.child)} WHERE ${ident(l.col)} = $1`, [id], client);
    if (rows[0].n > 0) counts.set(l.child, (counts.get(l.child) ?? 0) + rows[0].n);
  }
  return [...counts].map(([t, count]) => ({ table: t, label: LABELS[t] ?? t.replace(/_/g, ' '), count }));
}

/** "42 trips and 1 schedule" style list, joining tables that share a label. */
export function describeUsage(usage) {
  const byLabel = new Map();
  for (const u of usage) byLabel.set(u.label, (byLabel.get(u.label) ?? 0) + u.count);
  const parts = [...byLabel].map(([label, n]) => `${label} (${n})`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '';
}

/**
 * Throws 409 IN_USE when anything points at the record. `what` names it ("This bus"); `instead` says what to do
 * ("Untick Active to stop using it.").
 */
export async function assertUnused(client, table, id, { what, instead = '', skip = [] }) {
  const usage = await usageOf(client, table, id, { skip });
  if (usage.length) {
    throw new AppError(409, `${what} cannot be deleted: it is used by ${describeUsage(usage)}.${instead ? ` ${instead}` : ''}`, 'IN_USE', usage);
  }
}
