/**
 * Day plan (managers and admins): every trip of a day, or of a week, as a timetable to share with all staff.
 *   GET  /admin/day-plan?from=YYYY-MM-DD&to=YYYY-MM-DD   the trips per day, grouped by departure terminal, with the
 *                                                          published version and what changed since
 *   POST /admin/day-plan/publish { from, to }            publish each day in the range (a new version each time)
 * The PDF and CSV files are made in the browser from GET's answer.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, MANAGER_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { isoDate } from '../../utils/schemas.js';

const TZ = 'Asia/Karachi';
const DAY = 86_400_000;
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const pkDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });

const range = z
  .object({ from: isoDate, to: isoDate.optional() })
  .strict()
  .transform((r) => ({ from: r.from, to: r.to ?? r.from }))
  .refine((r) => r.to >= r.from, '"to" must be on or after "from"')
  .refine((r) => Date.parse(r.to) - Date.parse(r.from) <= 6 * DAY, 'A plan covers at most 7 days');

/** Fields compared with the published snapshot ("changed since published"). */
const TRACKED = {
  departureAt: 'departure time',
  delayMinutes: 'delay',
  status: 'status',
  busNo: 'bus',
  driverName: 'driver',
  conductorName: 'conductor',
  hostessName: 'hostess',
  routeName: 'route',
};
/** The compared fields, in the form they are stored in the snapshot (dates as ISO text). */
const tracked = (t) =>
  Object.fromEntries(Object.keys(TRACKED).map((k) => [k, t[k] instanceof Date ? t[k].toISOString() : t[k] ?? null]));

async function loadTrips(from, to, client) {
  const { rows } = await query(
    `SELECT t.id, t.departure_at, t.delay_minutes, t.status::text AS status, t.hostess_name, t.route_id,
            r.name AS route_name, r.code AS route_code,
            ot.id AS terminal_id, oc.name AS terminal_city, ot.name AS terminal_name,
            b.registration_no AS bus_no, b.fleet_no, b.has_hostess, l.total_seats,
            d.full_name AS driver_name, d.phone AS driver_phone,
            cn.full_name AS conductor_name, cn.phone AS conductor_phone, si.full_name AS stand_in_name,
            (SELECT count(*) FROM tickets tk WHERE tk.trip_id = t.id AND tk.status IN ('held','reserved','confirmed','boarded'))::int AS seats_sold
     FROM trips t
     JOIN routes r ON r.id = t.route_id
     JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
     JOIN buses b ON b.id = t.bus_id JOIN seat_layouts l ON l.id = b.layout_id
     LEFT JOIN drivers d ON d.id = t.driver_id
     LEFT JOIN conductors cn ON cn.id = t.conductor_id
     LEFT JOIN users si ON si.id = t.stand_in_conductor_id
     WHERE (t.departure_at AT TIME ZONE '${TZ}')::date BETWEEN $1::date AND $2::date
     ORDER BY t.departure_at, oc.name`,
    [from, to],
    client,
  );
  const routeIds = [...new Set(rows.map((t) => t.routeId))];
  const { rows: stops } = await query(
    `SELECT rs.route_id, rs.stop_order, rs.minutes_from_origin, c.name AS city
     FROM route_stops rs JOIN terminals tm ON tm.id = rs.terminal_id JOIN cities c ON c.id = tm.city_id
     WHERE rs.route_id = ANY ($1::int[]) ORDER BY rs.route_id, rs.stop_order`,
    [routeIds],
    client,
  );
  return rows.map((t) => {
    const start = new Date(t.departureAt).getTime() + (t.delayMinutes ?? 0) * 60_000;
    return {
      id: t.id,
      date: pkDate(t.departureAt),
      departureAt: t.departureAt,
      delayMinutes: t.delayMinutes ?? 0,
      status: t.status,
      routeName: t.routeName,
      routeCode: t.routeCode,
      terminalId: t.terminalId,
      terminal: `${t.terminalCity}`,
      terminalName: t.terminalName,
      busNo: t.busNo,
      fleetNo: t.fleetNo,
      totalSeats: t.totalSeats,
      seatsSold: t.seatsSold,
      driverName: t.driverName,
      driverPhone: t.driverPhone,
      conductorName: t.conductorName ?? t.standInName ?? null,
      conductorPhone: t.conductorName ? t.conductorPhone : null,
      hostessName: t.hostessName,
      busHasHostess: Boolean(t.hasHostess), // the bus carries a hostess (Fleet & people > Buses)
      // Every stop with its expected time (delay included).
      stops: stops
        .filter((s) => s.routeId === t.routeId)
        .map((s) => ({ city: s.city, at: new Date(start + s.minutesFromOrigin * 60_000).toISOString() })),
    };
  });
}

export const dayPlanRouter = Router();
dayPlanRouter.use(requireAuth, requireRole(...MANAGER_ROLES));

dayPlanRouter.get('/', validate({ query: range }), async (req, res) => {
  const { from, to } = req.valid.query;
  const trips = await loadTrips(from, to);
  const { rows: published } = await query(
    `SELECT plan_date::text AS plan_date, version, published_at, published_by_name, snapshot FROM day_plans WHERE plan_date BETWEEN $1 AND $2`,
    [from, to],
  );
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const pub = published.find((p) => p.planDate === d) ?? null;
    const snap = new Map((pub?.snapshot ?? []).map((s) => [s.id, s]));
    const dayTrips = trips
      .filter((t) => t.date === d)
      .map((t) => {
        if (!pub) return { ...t, change: null };
        const before = snap.get(t.id);
        if (!before) return { ...t, change: { kind: 'added', fields: [] } };
        const now = tracked(t);
        const fields = Object.keys(TRACKED).filter((k) => String(before[k] ?? '') !== String(now[k] ?? ''));
        return { ...t, change: fields.length ? { kind: 'changed', fields: fields.map((k) => TRACKED[k]) } : null };
      });
    // Published trips that no longer fall on this day (moved to another date).
    const gone = pub ? (pub.snapshot ?? []).filter((s) => !dayTrips.some((t) => t.id === s.id)) : [];
    days.push({
      date: d,
      published: pub && { version: pub.version, publishedAt: pub.publishedAt, publishedByName: pub.publishedByName },
      changedSincePublished: Boolean(pub) && (gone.length > 0 || dayTrips.some((t) => t.change)),
      trips: dayTrips,
      removed: gone.map((s) => ({ id: s.id, routeName: s.routeName, departureAt: s.departureAt, busNo: s.busNo })),
      missingCrew: dayTrips.filter((t) => t.status !== 'cancelled' && (!t.driverName || !t.conductorName)).length,
      // Buses that carry a hostess but have none assigned yet (counted separately from driver / conductor).
      missingHostess: dayTrips.filter((t) => t.status !== 'cancelled' && t.busHasHostess && !t.hostessName).length,
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ data: { from, to, days } });
});

dayPlanRouter.post('/publish', validate({ body: range }), async (req, res) => {
  const { from, to } = req.valid.body;
  const out = await withTransaction(async (client) => {
    const trips = await loadTrips(from, to, client);
    const who = req.user.fullName || req.user.email || 'Staff';
    const result = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const snapshot = trips.filter((t) => t.date === d).map((t) => ({ id: t.id, ...tracked(t) }));
      const { rows } = await query(
        `INSERT INTO day_plans (plan_date, version, published_at, published_by, published_by_name, snapshot)
         VALUES ($1, 1, now(), $2, $3, $4::jsonb)
         ON CONFLICT (plan_date) DO UPDATE SET version = day_plans.version + 1, published_at = now(),
              published_by = EXCLUDED.published_by, published_by_name = EXCLUDED.published_by_name, snapshot = EXCLUDED.snapshot
         RETURNING plan_date::text AS plan_date, version`,
        [d, req.user.id, who, JSON.stringify(snapshot)],
        client,
      );
      result.push({ ...rows[0], trips: snapshot.length });
    }
    await audit({ req, client, action: 'day_plan.publish', entityType: 'day_plan', entityId: `${from}..${to}`, newData: result });
    return result;
  });
  if (!out.length) throw AppError.badRequest('Nothing to publish');
  res.json({ data: out });
});
