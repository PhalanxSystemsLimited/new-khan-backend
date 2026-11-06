import { one } from '../../config/db.js';

/**
 * Find the active fare for a route segment and bus class on a given travel date
 * (date evaluated in Pakistan time). Returns null if no fare is configured.
 */
export function findFare({ routeId, fromStopId, toStopId, busClass, departureAt }, client) {
  return one(
    `SELECT id, amount, currency FROM fares
     WHERE route_id = $1 AND from_stop_id = $2 AND to_stop_id = $3 AND bus_class = $4
       AND valid_from <= ($5::timestamptz AT TIME ZONE 'Asia/Karachi')::date
       AND (valid_to IS NULL OR valid_to >= ($5::timestamptz AT TIME ZONE 'Asia/Karachi')::date)
     ORDER BY valid_from DESC
     LIMIT 1`,
    [routeId, fromStopId, toStopId, busClass, departureAt],
    client,
  );
}
