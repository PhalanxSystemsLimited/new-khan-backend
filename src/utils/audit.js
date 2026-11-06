import { query } from '../config/db.js';
import { logger } from './logger.js';

/**
 * Write an audit log entry. Pass `client` to make it part of a transaction.
 * Failures are logged but never break the main request when run outside a transaction.
 */
export async function audit({ req, action, entityType, entityId, oldData = null, newData = null, client }) {
  const sql = `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, old_data, new_data, ip_address)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`;
  const params = [
    req?.user?.id ?? null,
    action,
    entityType,
    String(entityId),
    oldData ? JSON.stringify(oldData) : null,
    newData ? JSON.stringify(newData) : null,
    req?.ip ?? null,
  ];
  if (client) return query(sql, params, client);
  try {
    await query(sql, params);
  } catch (err) {
    logger.error({ err }, 'Failed to write audit log');
  }
}
