import { pool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { reconcileSafepayBooking } from '../modules/payments/payments.routes.js';

/**
 * Releases seats held by unpaid bookings once their hold time passes. One run of the job; it is started in three
 * ways so the same code works on any host:
 *   - a long-running server (Hostinger VPS, PM2): startExpiryJob() runs it every minute in-process;
 *   - serverless (Vercel): GET /api/v1/internal/expire-bookings (Vercel Cron or any scheduler, CRON_SECRET), and
 *     expireStaleSoon() from trip search and seat maps, so held seats are freed as soon as someone looks;
 *   - optionally the database itself (Supabase pg_cron, see README §5).
 */
export async function runExpiryOnce() {
  // A customer may have paid on Safepay without coming back to the site: settle those before releasing seats.
  // expire_stale_bookings() keeps such bookings up to 20 minutes past the hold, so this check repeats meanwhile
  // and a Safepay outage cannot release seats that were paid for.
  const due = await pool.query(
    `SELECT DISTINCT b.id FROM bookings b JOIN payments p ON p.booking_id = b.id
     WHERE b.status = 'pending' AND b.hold_expires_at <= now()
       AND p.gateway = 'safepay' AND p.status IN ('initiated', 'pending') AND p.gateway_txn_id IS NOT NULL
     LIMIT 50`,
  );
  for (const r of due.rows) await reconcileSafepayBooking(r.id);
  const { rows } = await pool.query('SELECT expire_stale_bookings() AS n');
  if (rows[0].n > 0) logger.info({ expired: rows[0].n }, 'Expired unpaid bookings');
  return { reconciled: due.rows.length, expired: rows[0].n };
}

/** Long-running server: every minute in-process. If you run several instances, keep it on one (DISABLE_JOBS). */
export function startExpiryJob(intervalMs = 60_000) {
  if (process.env.DISABLE_JOBS === 'true') return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runExpiryOnce();
    } catch (err) {
      logger.error({ err }, 'Booking expiry job failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Cheap catch-up before showing seats: releases expired holds at most once every 30 seconds per server instance.
 * On a long-running server the minute job already does this; on serverless it keeps seat counts right between
 * scheduled runs. Never fails the request.
 */
let lastCatchUp = 0;
export async function expireStaleSoon() {
  if (Date.now() - lastCatchUp < 30_000) return;
  lastCatchUp = Date.now();
  try {
    await pool.query('SELECT expire_stale_bookings()');
  } catch (err) {
    logger.warn({ err }, 'Expiry catch-up failed');
  }
}
