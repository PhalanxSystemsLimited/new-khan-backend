import { env } from './config/env.js';
import { pool } from './config/db.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { startExpiryJob } from './jobs/expireBookings.js';
import { isConnectionError } from './utils/dbErrors.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info(`New Khan API listening on port ${env.PORT} (${env.NODE_ENV})`);
});

// Slowloris / hung-connection protection
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

const stopJob = startExpiryJob();

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  stopJob();
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'Unhandled promise rejection'));
process.on('uncaughtException', (err) => {
  // A lost database connection is temporary and the pool replaces it: never a reason to stop serving everyone.
  // (Transactions handle it themselves in config/db.js; this is the safety net for any other path.)
  if (isConnectionError(err)) {
    logger.error({ err }, 'Database connection error outside a request (server keeps running)');
    return;
  }
  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException');
});
