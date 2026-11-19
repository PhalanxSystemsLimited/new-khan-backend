/**
 * Tickets are sold on the departure (the scheduled time), not on a bus (migration 2026-11-22-bus-confirm.sql).
 *
 * Every trip keeps a bus, but a trip made by "Create trips" or as an extra departure without a bus has a PLANNED
 * bus only (trips.bus_confirmed = FALSE): it fixes the seat type (layout) and class the tickets are sold on, nothing
 * more. At departure time the counter, a manager or an admin opens Bus & crew and confirms the bus that actually goes
 * (the planned one or another free bus of the same seat type). Rules:
 *  - a planned bus never blocks another trip: the "bus is busy" check only counts confirmed trips;
 *  - no voucher, boarding or departure until the bus is confirmed;
 *  - trips that existed before the migration are confirmed (the column defaults to TRUE).
 *
 * Until the migration runs there is no bus_confirmed column: every trip counts as confirmed and everything works as
 * before (busConfirmReady guards every query).
 */
import { one } from '../../config/db.js';

let ready = false;
let checkedAt = 0;

/** Has the migration run? Checked once a minute until it has, then remembered. */
export async function busConfirmReady(client) {
  if (ready) return true;
  if (Date.now() - checkedAt < 60_000) return false;
  checkedAt = Date.now();
  const r = await one(
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'bus_confirmed') AS ok`,
    [],
    client,
  );
  ready = Boolean(r?.ok);
  return ready;
}
/** For tests. */
export const resetBusConfirmReady = () => {
  ready = false;
  checkedAt = 0;
};

/** SQL for "this trip's bus is confirmed": the column, or TRUE before the migration. */
export async function confirmedSql(alias, client) {
  return (await busConfirmReady(client)) ? `${alias}.bus_confirmed` : 'TRUE';
}

export const CONFIRM_FIRST = 'Confirm the bus first (Trips & boarding → Bus & crew): this trip only has a planned bus.';
