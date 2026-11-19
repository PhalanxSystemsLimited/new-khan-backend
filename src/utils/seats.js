/**
 * Seat numbers in number order: 1, 2, 3 ... 10 ... 49 (not 1, 10, 11, 2 as plain text would sort them).
 * Works for the old test labels too (1A, 1B ... 10A: by the leading number, then the letter).
 * `alias` is the layout_seats alias in the query, e.g. seatOrder('ls') inside ORDER BY.
 */
export const seatOrder = (alias) =>
  `NULLIF(substring(${alias}.seat_number from '^[0-9]+'), '')::int NULLS LAST, ${alias}.seat_number`;
