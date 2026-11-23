/**
 * A route built from chosen locations (New schedule and One-off trip: "Choose locations"): from, via stops, to,
 * with the travel time of each leg. An identical saved route (the same terminals in the same order) is reused;
 * otherwise a new one is created with a code and name made from its towns. Runs in the caller's transaction, so
 * the route and the schedule / trip that needed it are saved together or not at all.
 */
import { z } from 'zod';
import { one, query } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';
import { intId } from '../../utils/schemas.js';

export const customRouteSchema = z
  .object({
    // In travel order: from, any via stops, to.
    terminalIds: z.array(intId).min(2, 'Choose where the bus starts and where it ends').max(30),
    // Minutes of each leg: legMinutes[i] is from terminalIds[i] to terminalIds[i + 1].
    legMinutes: z.array(z.number().int().min(1, 'Travel time must be at least 1 minute').max(3000)).min(1).max(29),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (new Set(r.terminalIds).size !== r.terminalIds.length) {
      ctx.addIssue({ code: 'custom', message: 'A terminal can appear only once on a route' });
    }
    if (r.legMinutes.length !== r.terminalIds.length - 1) {
      ctx.addIssue({ code: 'custom', message: 'Give the travel time of every leg' });
    }
  });

const fail = (message) => AppError.badRequest(message, [{ field: 'customRoute', message }]);

/** A short piece for the route code: the letters part of the terminal code (NK-ISB → ISB), else the town's first letters. */
function shortName(terminalCode, cityName) {
  const parts = String(terminalCode ?? '').toUpperCase().split('-').filter((s) => /^[A-Z]{2,4}$/.test(s) && s !== 'NK');
  if (parts.length) return parts[parts.length - 1];
  return String(cityName ?? '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3) || 'X';
}

/** A free route code like NK-ISB-DIK, then NK-ISB-DIK-2, -3 ... */
async function freeCode(client, base) {
  const { rows } = await query(`SELECT code FROM routes WHERE code = $1 OR code LIKE $2`, [base, `${base}-%`], client);
  const taken = new Set(rows.map((r) => r.code));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  throw AppError.conflict('Too many routes between these two towns. Rename or remove some under Routes & stops.');
}

/**
 * The saved route with exactly these terminals in this order, or a new one.
 * Returns { id, code, name, created, hasFares }.
 */
export async function findOrCreateRoute(client, { terminalIds, legMinutes }) {
  // One at a time, so two saves of the same new route can't both create it.
  await client.query(`SELECT pg_advisory_xact_lock(7313, 1)`);

  const { rows: terms } = await query(
    `SELECT t.id, t.code, t.name, t.is_active, c.name AS city_name
     FROM terminals t JOIN cities c ON c.id = t.city_id WHERE t.id = ANY ($1::int[])`,
    [terminalIds],
    client,
  );
  const byId = new Map(terms.map((t) => [t.id, t]));
  for (const id of terminalIds) {
    const t = byId.get(id);
    if (!t) throw fail('One of the chosen terminals no longer exists. Close this form and open it again.');
    if (!t.isActive) throw fail(`${t.cityName} · ${t.name} is switched off. Switch it on under Locations first, or choose another terminal.`);
  }

  // An identical route: the same terminals in the same order. An active one first.
  const same = await one(
    `SELECT r.id, r.code, r.name, r.is_active,
            EXISTS (SELECT 1 FROM fares f WHERE f.route_id = r.id AND (f.valid_to IS NULL OR f.valid_to >= CURRENT_DATE)) AS has_fares
     FROM routes r
     WHERE (SELECT array_agg(rs.terminal_id ORDER BY rs.stop_order) FROM route_stops rs WHERE rs.route_id = r.id) = $1::int[]
     ORDER BY r.is_active DESC, r.id LIMIT 1`,
    [terminalIds],
    client,
  );
  if (same) {
    if (!same.isActive) {
      throw fail(`This is the saved route "${same.name}", which is switched off. Switch it on under Routes & stops, then choose it.`);
    }
    return { id: same.id, code: same.code, name: same.name, created: false, hasFares: same.hasFares };
  }

  // Distance of each leg, where a saved route already has that leg (two stops one after the other).
  const { rows: known } = await query(
    `SELECT DISTINCT ON (a.terminal_id, b.terminal_id) a.terminal_id AS from_id, b.terminal_id AS to_id,
            (b.km_from_origin - a.km_from_origin) AS km
     FROM route_stops a
     JOIN route_stops b ON b.route_id = a.route_id AND b.stop_order = a.stop_order + 1
     JOIN routes r ON r.id = a.route_id
     WHERE a.terminal_id = ANY ($1::int[]) AND b.terminal_id = ANY ($1::int[]) AND b.km_from_origin > a.km_from_origin
     ORDER BY a.terminal_id, b.terminal_id, r.is_active DESC, r.id`,
    [terminalIds],
    client,
  );
  const kmOf = new Map(known.map((k) => [`${k.fromId}-${k.toId}`, Number(k.km)]));
  const legKm = legMinutes.map((_, i) => kmOf.get(`${terminalIds[i]}-${terminalIds[i + 1]}`) ?? null);
  const allKm = legKm.every((k) => k !== null);

  const first = byId.get(terminalIds[0]);
  const last = byId.get(terminalIds[terminalIds.length - 1]);
  const via = terminalIds.slice(1, -1).map((id) => byId.get(id).cityName);
  const name = `${first.cityName} → ${last.cityName}${via.length ? ` (via ${via.join(', ')})` : ''}`.slice(0, 150);
  const code = await freeCode(client, `NK-${shortName(first.code, first.cityName)}-${shortName(last.code, last.cityName)}`);
  const totalMinutes = legMinutes.reduce((s, m) => s + m, 0);

  const route = await one(
    `INSERT INTO routes (code, name, origin_terminal_id, destination_terminal_id, distance_km, est_duration_minutes)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, code, name`,
    [code, name, first.id, last.id, allKm ? legKm.reduce((s, k) => s + k, 0) : null, totalMinutes],
    client,
  );
  let minutes = 0;
  let km = 0;
  for (const [i, terminalId] of terminalIds.entries()) {
    if (i > 0) {
      minutes += legMinutes[i - 1];
      km += allKm ? legKm[i - 1] : 0;
    }
    await client.query(
      `INSERT INTO route_stops (route_id, terminal_id, stop_order, minutes_from_origin, km_from_origin)
       VALUES ($1, $2, $3, $4, $5)`,
      [route.id, terminalId, i + 1, minutes, km],
    );
  }
  return { id: route.id, code: route.code, name: route.name, created: true, hasFares: false };
}
