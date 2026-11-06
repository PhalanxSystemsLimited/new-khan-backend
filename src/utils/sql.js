import { AppError } from './AppError.js';

/**
 * Build a safe UPDATE ... SET clause from validated data.
 * `columns` maps allowed camelCase input fields -> SQL column names.
 * Column identifiers come only from this hard-coded whitelist, never from input.
 *
 * Returns { setSql, values } where placeholders start at $startIndex.
 */
export function buildUpdate(data, columns, startIndex = 1) {
  const sets = [];
  const values = [];
  for (const [field, column] of Object.entries(columns)) {
    if (data[field] !== undefined) {
      values.push(data[field]);
      sets.push(`${column} = $${startIndex + values.length - 1}`);
    }
  }
  if (sets.length === 0) throw AppError.badRequest('No updatable fields provided');
  return { setSql: sets.join(', '), values };
}

export function offsetOf({ page, limit }) {
  return (page - 1) * limit;
}

export function paged(rows, { page, limit }, total) {
  return { data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
