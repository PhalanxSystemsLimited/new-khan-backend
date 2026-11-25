import fs from 'node:fs';
import pg from 'pg';
import { env } from './env.js';
import { logger } from '../utils/logger.js';
import { camelizeRow } from '../utils/case.js';

// Return NUMERIC as JS numbers (money values are well within safe range)
// and BIGINT ids as numbers too.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
// Keep DATE columns as 'YYYY-MM-DD' strings (avoid timezone shifts).
pg.types.setTypeParser(1082, (v) => v);

function sslConfig() {
  if (!env.DB_SSL) return false;
  // Certificate given as text (Vercel). A one-line value may write line breaks as the two characters \n.
  if (env.DB_SSL_CA) return { ca: env.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  if (env.DB_SSL_CA_PATH) {
    return { ca: fs.readFileSync(env.DB_SSL_CA_PATH, 'utf8'), rejectUnauthorized: true };
  }
  logger.warn('DB_SSL_CA_PATH not set: DB connection is encrypted but the server certificate is not verified.');
  return { rejectUnauthorized: false };
}

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
  query_timeout: 20_000,
  // TCP keep-alive: a connection the network has silently dropped is noticed, not found dead on the next request.
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  ssl: sslConfig(),
  application_name: 'new-khan-backend',
});

pool.on('error', (err) => logger.error({ err }, 'Unexpected idle DB client error'));

/**
 * A transaction that does nothing for this long is ended by the database itself, and its locks are released.
 * Without it, a transaction whose connection was lost half-way stayed open on the database (through the pooler)
 * for many minutes holding its row locks: a locked trip row stops every sale on that bus. No transaction in this
 * API waits anywhere near this long between two statements. Set per transaction (SET LOCAL), so it works the same
 * through Supabase's session pooler (5432) and transaction pooler (6543).
 */
const IDLE_IN_TRANSACTION_MS = 60_000;

/** Run a parameterised query. Rows are returned with camelCase keys. */
export async function query(text, params = [], client = pool) {
  const res = await client.query(text, params);
  return { rows: res.rows.map(camelizeRow), rowCount: res.rowCount };
}

export async function one(text, params = [], client = pool) {
  const { rows } = await query(text, params, client);
  return rows[0] ?? null;
}

/**
 * Run fn(client) inside a transaction. Commits on success, rolls back on error.
 */
export async function withTransaction(fn, { isolation = 'READ COMMITTED' } = {}) {
  const client = await pool.connect();
  // While a connection is checked out the pool does not listen for its errors. A connection that drops between
  // two statements then raised an "error" event nobody handled, which Node treats as fatal: the whole API went
  // down for one lost connection. Listen here instead: the statement that follows fails and only this request does.
  let broken = null;
  const onError = (err) => {
    broken = err;
    logger.warn({ err }, 'Database connection lost during a transaction');
  };
  client.on('error', onError);
  try {
    // One round trip: the two statements go in a single message.
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}; SET LOCAL idle_in_transaction_session_timeout = ${IDLE_IN_TRANSACTION_MS}`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (!broken) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        // The connection's state is unknown now: it must not go back into the pool.
        broken = rollbackErr;
        logger.error({ err: rollbackErr }, 'Rollback failed');
      }
    }
    throw err;
  } finally {
    client.removeListener('error', onError);
    // A broken connection is closed and replaced, never handed to the next request.
    client.release(broken ?? undefined);
  }
}
