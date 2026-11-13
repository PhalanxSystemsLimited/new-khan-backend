/**
 * Phase 2: round trip reports filled in from the real trips and their terminal vouchers.
 *
 * createFromTrips: the admin picks the outbound trip and the return trip (same bus). The report gets the bus, driver,
 * conductor (printed as fare collector), date, route, distance (both routes' km) and one leg per trip, the
 * off-route defaults as before, and then every generated terminal voucher of both trips (syncFromVouchers).
 *
 * syncFromVouchers: one report row per generated terminal voucher:
 *   passengers terminal  = paid seats boarding at that terminal (voucher)
 *   income terminal      = terminal cash (paid in cash at the counter)
 *   online sale          = seats paid online, under "Web app"
 *   passengers/income en route = the conductor's road passengers who boarded after that terminal
 *   load, cargo          = voucher
 *   on-route expenses    = the voucher's terminal deductions (Adda, loader, cleaner...)
 * A replaced voucher is swapped for its replacement, a void one is removed. Rows an admin changed by hand are left
 * alone unless includeEdited is set. Diesel, E-tag / toll tax, mobil oil, other expense/income and the cashier stay
 * manual.
 */
import { query, one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { loadTrip, voucherStops } from '../tripvouchers/tripVouchers.service.js';
import { copyOffrouteDefaults, issueToken } from './roundtrips.service.js';

const TZ = 'Asia/Karachi';
const pkDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
/** "Lahore → DI Khan (via Sargodha, Mianwali)" → "Lahore ⇄ DI Khan (via Sargodha, Mianwali)" */
export const roundTripLabel = (routeName) => String(routeName).replace(/\s*(→|->)\s*/, ' ⇄ ').slice(0, 120);

/** Trips an admin can build a report from, newest first, with whether each is already in a report. */
export async function tripOptions({ from, to, busId }) {
  const { rows } = await query(
    `SELECT t.id, t.departure_at, t.status, t.bus_id, t.route_id, r.name AS route_name, r.code AS route_code,
            r.origin_terminal_id, r.destination_terminal_id,
            COALESCE(b.fleet_no, b.registration_no) AS bus,
            (SELECT count(*) FROM trip_vouchers tv WHERE tv.trip_id = t.id AND tv.status = 'generated')::int AS vouchers,
            (SELECT l.round_trip_id FROM round_trip_legs l WHERE l.trip_id = t.id) AS in_report
     FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
     WHERE t.status <> 'cancelled'
       AND (t.departure_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
       AND ($3::int IS NULL OR t.bus_id = $3)
     ORDER BY t.departure_at DESC
     LIMIT 300`,
    [from, to, busId ?? null],
  );
  return rows;
}

/** Terminals of the report's trips that have not generated their voucher yet. */
export async function missingVouchers(client, roundTripId) {
  const { rows: legs } = await query(
    `SELECT id, leg_no, trip_id FROM round_trip_legs WHERE round_trip_id = $1 AND trip_id IS NOT NULL ORDER BY leg_no`,
    [roundTripId],
    client,
  );
  const missing = [];
  for (const leg of legs) {
    const loaded = await loadTrip(leg.tripId, client);
    if (!loaded || loaded.trip.status === 'cancelled') continue;
    const { rows: done } = await query(`SELECT boarding_stop_id FROM trip_vouchers WHERE trip_id = $1 AND status = 'generated'`, [leg.tripId], client);
    for (const s of voucherStops(loaded.stops)) {
      if (!done.some((d) => d.boardingStopId === s.id)) {
        missing.push({ tripId: leg.tripId, legNo: leg.legNo, departureAt: loaded.trip.departureAt, routeName: loaded.trip.routeName, city: s.city });
      }
    }
  }
  return missing;
}

const shortDate = (d) => new Date(d).toLocaleDateString('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });

/** "Leg 1 (6 Nov): Islamabad · Leg 2 (7 Nov): Islamabad" for messages about missing vouchers. */
export function missingByLeg(missing) {
  const legs = new Map();
  for (const m of missing) {
    const key = m.legNo ?? 0;
    if (!legs.has(key)) legs.set(key, { legNo: m.legNo, date: m.departureAt ? shortDate(m.departureAt) : '', cities: [] });
    legs.get(key).cities.push(m.city);
  }
  return [...legs.values()].map((l) => `${l.legNo ? `Leg ${l.legNo}${l.date ? ` (${l.date})` : ''}: ` : ''}${l.cities.join(', ')}`).join(' · ');
}

/**
 * Warnings for a report whose legs do not look like one journey (automatic or built by hand). Advisory only:
 *   a leg that never ran or was cancelled, a leg that does not start where the previous one ended (a trip is
 *   missing), a long gap between legs, and legs spread over more than 3 days.
 */
export async function reportChecks(client, roundTripId) {
  const { rows } = await query(
    `SELECT l.leg_no, t.id AS trip_id, t.status::text AS status, t.departure_at, COALESCE(t.arrival_at, t.departure_at) AS arrival_at,
            oc.id AS from_city_id, oc.name AS from_city, dc.id AS to_city_id, dc.name AS to_city
     FROM round_trip_legs l
     JOIN trips t ON t.id = l.trip_id
     JOIN routes r ON r.id = t.route_id
     JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id JOIN cities dc ON dc.id = dt.city_id
     WHERE l.round_trip_id = $1
     ORDER BY l.leg_no`,
    [roundTripId],
    client,
  );
  const issues = [];
  const hoursBetween = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
  const spell = (h) => (h < 48 ? `${Math.round(h)} hours` : `${Math.round(h / 24)} days`);
  rows.forEach((leg, i) => {
    const name = `Leg ${leg.legNo} (${shortDate(leg.departureAt)})`;
    if (leg.status === 'cancelled') issues.push(`${name} was cancelled.`);
    else if (!RAN.includes(leg.status)) issues.push(`${name} was never marked departed or arrived.`);
    const prev = rows[i - 1];
    if (!prev) return;
    if (prev.toCityId !== leg.fromCityId) {
      issues.push(`Leg ${leg.legNo} starts in ${leg.fromCity}, but leg ${prev.legNo} ended in ${prev.toCity}. A trip may be missing.`);
    }
    const gap = hoursBetween(prev.arrivalAt, leg.departureAt);
    if (gap > MAX_LEG_GAP_HOURS) issues.push(`Leg ${leg.legNo} left ${spell(gap)} after leg ${prev.legNo} arrived.`);
  });
  if (rows.length > 1) {
    const span = hoursBetween(rows[0].departureAt, rows[rows.length - 1].arrivalAt);
    if (span > 72) issues.push(`These legs span ${spell(span)} (a round trip normally takes 1 to 3 days).`);
  }
  return issues;
}

/** The figures of one report row, from a generated terminal voucher. */
async function figuresFor(client, tv) {
  // One after another: these run on the transaction's single connection.
  const road = await one(
    `SELECT count(*)::int AS pax, COALESCE(sum(CASE WHEN tk.is_free THEN 0 ELSE tk.fare_amount END), 0)::int AS income
     FROM tickets tk JOIN bookings bk ON bk.id = tk.booking_id
     WHERE tk.trip_id = $1 AND bk.channel = 'on_road' AND bk.boarding_stop_id = $2 AND tk.status IN ('confirmed', 'boarded')`,
    [tv.tripId, tv.boardingStopId],
    client,
  );
  const online = await one(
    `SELECT count(*)::int AS seats, COALESCE(sum(fare), 0)::int AS amount FROM trip_voucher_passengers
     WHERE voucher_id = $1 AND paid_by IS NOT NULL AND paid_by <> 'cash' AND NOT is_free`,
    [tv.id],
    client,
  );
  const deductions = await query(
    `SELECT category_id, name, amount FROM trip_voucher_deductions WHERE voucher_id = $1 AND amount > 0 ORDER BY id`,
    [tv.id],
    client,
  );
  return {
    terminalId: tv.terminalId,
    terminalName: tv.terminalName,
    departureAt: tv.departureAt,
    paxTerminal: tv.seatsBoarding,
    paxEnroute: road.pax,
    incTerminal: tv.terminalCash,
    incEnroute: road.income,
    loadAmount: tv.loadAmount,
    cargoAmount: tv.cargoAmount,
    onroute: deductions.rows,
    online: online.seats || online.amount ? [{ seats: online.seats, amount: online.amount }] : [],
  };
}

async function writeLines(client, rowId, f, webApp) {
  await client.query(`DELETE FROM voucher_onroute_lines WHERE voucher_id = $1`, [rowId]);
  await client.query(`DELETE FROM voucher_online_sales WHERE voucher_id = $1`, [rowId]);
  for (const d of f.onroute) {
    await client.query(`INSERT INTO voucher_onroute_lines (voucher_id, category_id, name, amount) VALUES ($1, $2, $3, $4)`, [rowId, d.categoryId, d.name, d.amount]);
  }
  for (const o of f.online) {
    await client.query(
      `INSERT INTO voucher_online_sales (voucher_id, platform_id, platform_name, seats, amount) VALUES ($1, $2, $3, $4, $5)`,
      [rowId, webApp?.id ?? null, webApp?.name ?? 'Web app', o.seats, o.amount],
    );
  }
}

/** The live voucher a replaced one now stands for (follows the replacement chain). */
async function currentOf(client, tripVoucherId) {
  let id = tripVoucherId;
  for (let i = 0; i < 20; i++) {
    const v = await one(`SELECT id, status FROM trip_vouchers WHERE id = $1`, [id], client);
    if (!v || v.status !== 'replaced') return v;
    const next = await one(`SELECT id FROM trip_vouchers WHERE replaces_id = $1`, [id], client);
    if (!next) return v;
    id = next.id;
  }
  return null;
}

export async function syncFromVouchers(client, roundTripId, { includeEdited = false, userId = null } = {}) {
  const result = { added: 0, updated: 0, keptEdited: 0, removed: 0 };
  const webApp = await one(`SELECT id, name FROM online_platforms WHERE lower(name) = 'web app'`, [], client);
  const { rows: legs } = await query(`SELECT id, trip_id FROM round_trip_legs WHERE round_trip_id = $1 AND trip_id IS NOT NULL ORDER BY leg_no`, [roundTripId], client);

  // Rows already copied: follow replacements, drop voided vouchers.
  const { rows: linked } = await query(
    `SELECT v.id, v.trip_voucher_id FROM terminal_vouchers v WHERE v.round_trip_id = $1 AND v.trip_voucher_id IS NOT NULL`,
    [roundTripId],
    client,
  );
  for (const row of linked) {
    const cur = await currentOf(client, row.tripVoucherId);
    if (!cur || cur.status === 'void') {
      await client.query(`DELETE FROM terminal_vouchers WHERE id = $1`, [row.id]);
      result.removed += 1;
    } else if (cur.id !== row.tripVoucherId) {
      const taken = await one(`SELECT id FROM terminal_vouchers WHERE trip_voucher_id = $1`, [cur.id], client);
      if (taken) {
        await client.query(`DELETE FROM terminal_vouchers WHERE id = $1`, [row.id]);
        result.removed += 1;
      } else {
        await client.query(`UPDATE terminal_vouchers SET trip_voucher_id = $2 WHERE id = $1`, [row.id, cur.id]);
      }
    }
  }

  for (const leg of legs) {
    const loaded = await loadTrip(leg.tripId, client);
    if (!loaded) continue;
    const order = new Map(loaded.stops.map((s) => [s.id, s.stopOrder]));
    const { rows: tvs } = await query(`SELECT * FROM trip_vouchers WHERE trip_id = $1 AND status = 'generated' ORDER BY departure_at`, [leg.tripId], client);
    for (const tv of tvs) {
      const f = await figuresFor(client, tv);
      const sortOrder = order.get(tv.boardingStopId) ?? 0;
      const row = await one(`SELECT id, edited_after_sync FROM terminal_vouchers WHERE trip_voucher_id = $1 AND round_trip_id = $2`, [tv.id, roundTripId], client);
      if (row?.editedAfterSync && !includeEdited) {
        result.keptEdited += 1;
        continue;
      }
      const values = [f.terminalId, f.terminalName, f.departureAt, f.paxTerminal, f.paxEnroute, f.incTerminal, f.incEnroute, f.loadAmount, f.cargoAmount];
      let rowId;
      if (row) {
        await client.query(
          `UPDATE terminal_vouchers SET leg_id = $2, sort_order = $3, terminal_id = $4, terminal_name = $5, departure_at = $6,
                  pax_terminal = $7, pax_enroute = $8, inc_terminal = $9, inc_enroute = $10, load_amount = $11, cargo_amount = $12,
                  synced_at = now(), edited_after_sync = FALSE
           WHERE id = $1`,
          [row.id, leg.id, sortOrder, ...values],
        );
        rowId = row.id;
        result.updated += 1;
      } else {
        const ins = await one(
          `INSERT INTO terminal_vouchers (voucher_no, trip_voucher_id, round_trip_id, leg_id, sort_order, terminal_id, terminal_name, departure_at,
                                          pax_terminal, pax_enroute, inc_terminal, inc_enroute, load_amount, cargo_amount, created_by, synced_at)
           VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, now()) RETURNING id`,
          [tv.id, roundTripId, leg.id, sortOrder, ...values, userId],
          client,
        );
        rowId = ins.id;
        await issueToken(client, { roundTripId, voucherId: rowId, userId });
        result.added += 1;
      }
      await writeLines(client, rowId, f, webApp);
    }
  }
  await client.query(`UPDATE round_trips SET updated_at = now() WHERE id = $1`, [roundTripId]);
  return result;
}

export const MAX_LEGS = 12;

/** Route endpoints with city names and whether each end is an origin terminal (Lahore, Multan). */
async function routeEnds(client, routeIds) {
  const { rows } = await query(
    `SELECT r.id, r.name, r.distance_km, oc.name AS from_city, dc.name AS to_city,
            ot.is_origin AS from_origin, dt.is_origin AS to_origin
     FROM routes r
     JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id JOIN cities dc ON dc.id = dt.city_id
     WHERE r.id = ANY ($1::int[])`,
    [routeIds],
    client,
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/**
 * Printed route of the whole round trip: "Lahore ⇄ DI Khan (via Sargodha, Mianwali)" for a simple out-and-back,
 * otherwise the cities in order, e.g. "Lahore → Islamabad → DI Khan → Mianwali → Lahore".
 */
function chainLabel(trips, ends) {
  const r = trips.map((t) => ends.get(t.trip.routeId));
  if (r.length === 2 && r[0].fromCity === r[1].toCity && r[0].toCity === r[1].fromCity) return roundTripLabel(r[0].name);
  if (r.length === 1) return String(r[0].name).slice(0, 120);
  const cities = [r[0].fromCity, ...r.map((x) => x.toCity)];
  return cities.join(' → ').slice(0, 120);
}

/** A new draft report from a bus's trips, in the order travelled (one leg per trip). */
export async function createFromTripIds(client, { userId, tripIds, autoCreated = false }) {
  if (!tripIds.length) throw AppError.badRequest('Choose at least one trip.');
  if (tripIds.length > MAX_LEGS) throw AppError.unprocessable(`A round trip report can have at most ${MAX_LEGS} legs.`);
  if (new Set(tripIds).size !== tripIds.length) throw AppError.badRequest('Each trip can be chosen only once.');
  const trips = [];
  for (const id of tripIds) {
    const t = await loadTrip(id, client);
    if (!t) throw AppError.notFound(`Trip ${id} not found`);
    if (t.trip.status === 'cancelled') throw AppError.unprocessable(`Trip ${id} was cancelled.`);
    trips.push(t);
  }
  const first = trips[0];
  for (const [i, t] of trips.entries()) {
    if (t.trip.busId !== first.trip.busId) {
      throw AppError.unprocessable(`Trip ${t.trip.id} uses a different bus (${t.trip.registrationNo}, not ${first.trip.registrationNo}).`);
    }
    if (i > 0 && new Date(t.trip.departureAt) <= new Date(trips[i - 1].trip.departureAt)) {
      throw AppError.unprocessable('The trips must be in the order the bus travelled them.');
    }
  }
  const used = await one(`SELECT round_trip_id, trip_id FROM round_trip_legs WHERE trip_id = ANY ($1::bigint[]) LIMIT 1`, [tripIds], client);
  if (used) throw AppError.conflict(`Trip ${used.tripId} is already in round trip report ${used.roundTripId}.`);

  const ends = await routeEnds(client, [...new Set(trips.map((t) => t.trip.routeId))]);
  const distance = trips.reduce((s, t) => s + Number(ends.get(t.trip.routeId)?.distanceKm ?? 0), 0);
  const driver = await one(`SELECT driver_id FROM trips WHERE id = $1`, [first.trip.id], client);
  const last = trips[trips.length - 1];

  const rt = await one(
    `INSERT INTO round_trips (route_id, bus_id, driver_id, fare_collector, route_label, report_date, distance_km, created_by, auto_created)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      first.trip.routeId, first.trip.busId, driver?.driverId ?? null,
      first.trip.conductorName ?? first.trip.standInConductorName ?? null,
      chainLabel(trips, ends),
      pkDate(last.trip.departureAt),
      distance, userId, autoCreated,
    ],
    client,
  );
  for (const [i, t] of trips.entries()) {
    await client.query(`INSERT INTO round_trip_legs (round_trip_id, leg_no, title, trip_id) VALUES ($1, $2, $3, $4)`, [rt.id, i + 1, t.trip.routeName.slice(0, 150), t.trip.id]);
  }
  await copyOffrouteDefaults(client, { roundTripId: rt.id, routeId: first.trip.routeId, busId: first.trip.busId });
  await issueToken(client, { roundTripId: rt.id, userId });
  const sync = await syncFromVouchers(client, rt.id, { userId });
  return { id: rt.id, sync };
}

/** The admin's choice: an outbound trip and (optionally) its return trip on the same bus. */
export const createFromTrips = (client, { userId, outboundTripId, returnTripId = null }) =>
  createFromTripIds(client, { userId, tripIds: [outboundTripId, returnTripId].filter(Boolean) });

/** A gap longer than this between two legs means a different journey (the round trip walk stops there). */
export const MAX_LEG_GAP_HOURS = 36;
const RAN = ['departed', 'arrived'];

/**
 * The bus's round trip that ends with `lastTripId`: walking back through the bus's earlier trips until the one that
 * left an origin terminal (Lahore, Multan). The walk also stops (so a report never sweeps up days of unrelated trips)
 * at an earlier trip that:
 *   - is already in a report, or more than MAX_LEGS back (as before; cancelled trips are skipped);
 *   - did not run (not marked departed or arrived);
 *   - does not connect: it ended in a different city from where the next leg starts (a trip is missing);
 *   - arrived more than MAX_LEG_GAP_HOURS before the next leg left.
 * Returns the trip ids in the order travelled.
 */
export async function chainEndingWith(client, lastTripId) {
  // Compared inside the database: a JavaScript date would round the departure time to milliseconds.
  // Rows come newest first; lag() is the next (later) leg of each row.
  const { rows } = await query(
    `SELECT t.id, t.status::text AS status, ot.is_origin AS starts_at_origin, dt.city_id AS to_city_id,
            EXISTS (SELECT 1 FROM round_trip_legs l WHERE l.trip_id = t.id) AS in_report,
            lag(ot.city_id) OVER w AS next_from_city_id,
            EXTRACT(EPOCH FROM (lag(t.departure_at) OVER w - COALESCE(t.arrival_at, t.departure_at))) / 3600 AS gap_hours
     FROM trips last
     JOIN trips t ON t.bus_id = last.bus_id AND t.departure_at <= last.departure_at AND t.status <> 'cancelled'
     JOIN routes r ON r.id = t.route_id
     JOIN terminals ot ON ot.id = r.origin_terminal_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id
     WHERE last.id = $1
     WINDOW w AS (ORDER BY t.departure_at DESC)
     ORDER BY t.departure_at DESC
     LIMIT ${MAX_LEGS}`,
    [lastTripId],
    client,
  );
  const chain = [];
  for (const [i, t] of rows.entries()) {
    if (t.inReport) break;
    if (i > 0) {
      if (!RAN.includes(t.status)) break;
      if (t.toCityId !== t.nextFromCityId) break;
      if (Number(t.gapHours) > MAX_LEG_GAP_HOURS) break;
    }
    chain.unshift(t.id);
    if (t.startsAtOrigin) break;
  }
  return chain;
}

/**
 * Makes the bus's round trip report if `tripId` closes one and it has none yet. Used when a trip ending at an
 * origin terminal is marked Arrived, and (safety net) when the bus starts its next trip from an origin.
 * Runs inside a savepoint: a problem here never stops the status change; it is returned instead.
 */
export async function autoCreateReport(client, { tripId, userId = null, requireOriginEnd = true }) {
  await client.query('SAVEPOINT auto_report');
  try {
    const t = await one(
      `SELECT t.id, dt.is_origin AS ends_at_origin, EXISTS (SELECT 1 FROM round_trip_legs l WHERE l.trip_id = t.id) AS in_report
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN terminals dt ON dt.id = r.destination_terminal_id
       WHERE t.id = $1 AND t.status <> 'cancelled'`,
      [tripId],
      client,
    );
    if (!t || t.inReport || (requireOriginEnd && !t.endsAtOrigin)) {
      await client.query('RELEASE SAVEPOINT auto_report');
      return null;
    }
    const tripIds = await chainEndingWith(client, tripId);
    const made = tripIds.length ? await createFromTripIds(client, { userId, tripIds, autoCreated: true }) : null;
    await client.query('RELEASE SAVEPOINT auto_report');
    return made && { roundTripId: made.id, tripIds };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT auto_report');
    return { error: err.message };
  }
}

/** Safety net: the bus is leaving an origin again, so its previous trip (if not in a report) closes a round trip. */
export async function closePreviousRoundTrip(client, { tripId, userId = null }) {
  const prev = await one(
    `SELECT p.id FROM trips t
     JOIN routes r ON r.id = t.route_id JOIN terminals ot ON ot.id = r.origin_terminal_id
     JOIN trips p ON p.bus_id = t.bus_id AND p.departure_at < t.departure_at AND p.status <> 'cancelled'
     WHERE t.id = $1 AND ot.is_origin
       AND NOT EXISTS (SELECT 1 FROM round_trip_legs l WHERE l.trip_id = p.id)
     ORDER BY p.departure_at DESC LIMIT 1`,
    [tripId],
    client,
  );
  return prev ? autoCreateReport(client, { tripId: prev.id, userId, requireOriginEnd: false }) : null;
}

/**
 * Finds buses that have come back to an origin terminal without a report (trips ending at an origin, arrived,
 * not in any report, last N days) and makes their reports. Button on the reports page; also a safety net.
 */
export async function scanCompletedRoundTrips(client, { userId = null, days = 30 } = {}) {
  const { rows } = await query(
    `SELECT t.id FROM trips t
     JOIN routes r ON r.id = t.route_id JOIN terminals dt ON dt.id = r.destination_terminal_id
     WHERE t.status = 'arrived' AND dt.is_origin
       AND t.departure_at > now() - make_interval(days => $1)
       AND NOT EXISTS (SELECT 1 FROM round_trip_legs l WHERE l.trip_id = t.id)
     ORDER BY t.departure_at`,
    [days],
    client,
  );
  const made = [];
  const problems = [];
  for (const r of rows) {
    const res = await autoCreateReport(client, { tripId: r.id, userId });
    if (res?.roundTripId) made.push(res);
    else if (res?.error) problems.push({ tripId: r.id, error: res.error });
  }
  return { made, problems };
}
