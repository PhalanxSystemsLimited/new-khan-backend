/**
 * Creating one-off trips (Trips & boarding → "+ One-off trip"), optionally with the same bus's return trip.
 * Both trips go through the same checks and are saved in the caller's transaction: both or neither.
 */
import { one } from '../../config/db.js';
import { AppError } from '../../utils/AppError.js';

/** A return leaving sooner than this after the bus arrives is allowed, with a warning. */
export const SHORT_TURNAROUND_MINUTES = 30;

const pkTime = (d) =>
  new Date(d).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });

/** The route with its start and end city, or an error naming the field. */
async function activeRoute(client, routeId, field, prefix) {
  const route = await one(
    `SELECT r.id, r.name, r.est_duration_minutes, ot.city_id AS from_city_id, oc.name AS from_city,
            dt.city_id AS to_city_id, dc.name AS to_city
     FROM routes r
     JOIN terminals ot ON ot.id = r.origin_terminal_id JOIN cities oc ON oc.id = ot.city_id
     JOIN terminals dt ON dt.id = r.destination_terminal_id JOIN cities dc ON dc.id = dt.city_id
     WHERE r.id = $1 AND r.is_active`,
    [routeId],
    client,
  );
  if (!route?.estDurationMinutes) {
    throw AppError.badRequest(`${prefix}Route not found, inactive, or missing duration`, [{ field, message: 'Route not found, inactive, or missing duration' }]);
  }
  return route;
}

async function assertBusFree(client, busId, departureAt, arrivalAt, prefix) {
  const clash = await one(
    `SELECT id FROM trips
     WHERE bus_id = $1 AND status NOT IN ('cancelled', 'arrived')
       AND tstzrange(departure_at, arrival_at) && tstzrange($2::timestamptz, $3::timestamptz)
     LIMIT 1`,
    [busId, departureAt, arrivalAt],
    client,
  );
  if (clash) throw AppError.conflict(`${prefix}Bus is already assigned to trip ${clash.id} at that time`);
}

async function assertDriversValid(client, ids, prefix) {
  for (const id of ids.filter(Boolean)) {
    const d = await one(`SELECT is_active, license_expiry >= CURRENT_DATE AS valid FROM drivers WHERE id = $1`, [id], client);
    if (!d) throw AppError.badRequest(`${prefix}Driver ${id} not found`);
    if (!d.isActive || !d.valid) throw AppError.unprocessable(`${prefix}Driver ${id} is inactive or has an expired license`);
  }
}

async function assertConductorValid(client, id) {
  if (!id) return;
  const c = await one(`SELECT is_active FROM conductors WHERE id = $1`, [id], client);
  if (!c) throw AppError.badRequest('Conductor not found');
  if (!c.isActive) throw AppError.unprocessable('That conductor is inactive');
}

/** Checks and inserts one trip on an already-loaded route. */
async function insertTrip(client, route, b, prefix) {
  const bus = await one(`SELECT id FROM buses WHERE id = $1 AND is_active FOR UPDATE`, [b.busId], client);
  if (!bus) throw AppError.badRequest(`${prefix}Bus not found or inactive`);

  const arrivalAt = new Date(Date.parse(b.departureAt) + route.estDurationMinutes * 60_000).toISOString();
  await assertBusFree(client, b.busId, b.departureAt, arrivalAt, prefix);
  await assertDriversValid(client, [b.driverId, b.coDriverId], prefix);
  await assertConductorValid(client, b.conductorId);

  const trip = await one(
    `INSERT INTO trips (route_id, bus_id, driver_id, co_driver_id, hostess_name, departure_at, arrival_at, booking_closes_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $6::timestamptz - make_interval(mins => $8)) RETURNING *`,
    [b.routeId, b.busId, b.driverId ?? null, b.coDriverId ?? null, b.hostessName ?? null, b.departureAt, arrivalAt, b.bookingCloseMinutes],
    client,
  );
  // Separate statement so creating trips keeps working on a database without the conductor column.
  if (b.conductorId) return one(`UPDATE trips SET conductor_id = $2 WHERE id = $1 RETURNING *`, [trip.id, b.conductorId], client);
  return trip;
}

/**
 * Creates the trip and, when `b.returnTrip` is given, the same bus's return trip. Run inside a transaction.
 * The return must start in the city where the outbound ends and leave after the bus arrives there.
 * Returns { trip, returnTrip, warnings }.
 */
export async function createTripWithReturn(client, b) {
  const outRoute = await activeRoute(client, b.routeId, 'routeId', '');
  const trip = await insertTrip(client, outRoute, b, '');
  if (!b.returnTrip) return { trip, returnTrip: null, warnings: [] };

  const r = b.returnTrip;
  const P = 'Return trip: ';
  const backRoute = await activeRoute(client, r.routeId, 'returnRouteId', P);
  if (backRoute.fromCityId !== outRoute.toCityId) {
    const msg = `The return route must start in ${outRoute.toCity}, where the bus arrives. ${backRoute.name} starts in ${backRoute.fromCity}.`;
    throw AppError.badRequest(P + msg, [{ field: 'returnRouteId', message: msg }]);
  }
  const arrives = new Date(trip.arrivalAt).getTime();
  const leaves = Date.parse(r.departureAt);
  if (leaves < arrives) {
    const msg = `The bus only reaches ${outRoute.toCity} at ${pkTime(arrives)}. The return must leave at or after that time.`;
    throw AppError.badRequest(P + msg, [{ field: 'returnDepartureAt', message: msg }]);
  }
  const returnTrip = await insertTrip(
    client,
    backRoute,
    { routeId: r.routeId, busId: b.busId, driverId: r.driverId, departureAt: r.departureAt, bookingCloseMinutes: b.bookingCloseMinutes },
    P,
  );
  const warnings = [];
  const turnaround = Math.round((leaves - arrives) / 60_000);
  if (turnaround < SHORT_TURNAROUND_MINUTES) {
    warnings.push(`Only ${turnaround} minutes between the bus arriving in ${outRoute.toCity} and leaving again. Any delay on the way will make the return late.`);
  }
  return { trip, returnTrip, warnings };
}
