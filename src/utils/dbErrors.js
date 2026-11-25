/**
 * Tells "the database connection failed" apart from "this request was wrong".
 * A connection failure (network drop, pooler full, database restarting, a transaction ended by the idle timeout)
 * is temporary: the request is answered 503 "please try again" and the server keeps running.
 */

// Network errors from Node's socket layer.
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

// PostgreSQL SQLSTATE codes: 57P01-57P03 server shutting down / crashed / starting, 53300 too many connections,
// 25P03 transaction ended by idle_in_transaction_session_timeout. Class 08 (connection exception) is matched below.
const PG_CODES = new Set(['57P01', '57P02', '57P03', '53300', '25P03']);

// Messages from pg, pg-pool and the Supabase pooler that carry no useful code.
const MESSAGE = /connection terminated|connection timeout|timeout exceeded when trying to connect|max clients reached|EMAXCONN|client has encountered a connection error|connection ended unexpectedly|server closed the connection/i;

export function isConnectionError(err) {
  if (!err || typeof err !== 'object') return false;
  const code = typeof err.code === 'string' ? err.code : '';
  if (NETWORK_CODES.has(code) || PG_CODES.has(code) || /^08[0-9A-Z]{3}$/.test(code)) return true;
  if (typeof err.message === 'string' && MESSAGE.test(err.message)) return true;
  // pg wraps the original error: "Connection terminated due to connection timeout" { cause }.
  return err.cause && err.cause !== err ? isConnectionError(err.cause) : false;
}
