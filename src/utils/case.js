const toCamel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** Convert top-level snake_case keys of a DB row to camelCase. */
export function camelizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) out[toCamel(key)] = row[key];
  return out;
}
