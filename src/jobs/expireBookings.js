import { pool } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { reconcileSafepayBooking } from '../modules/payments/payments.routes.js';

/**
 * Releases seats held by unpaid bookings once their hold time passes.
 * Runs every minute in-process. If you ever run several instances, keep it
 * enabled on one only (or move it to Supabase pg_cron:
 *   select cron.schedule('expire-bookings', '* * * * *', 'select public.expire_stale_bookings()');
 * and set DISABLE_JOBS=true).
 */
export function startExpiryJob(intervalMs = 60_000) {
  if (process.env.DISABLE_JOBS === 'true') return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      // A customer may have paid on Safepay without coming back to the site: settle those before releasing seats.
      // expire_stale_bookings() keeps such bookings up to 20 minutes past the hold, so this check repeats each
      // minute meanwhile and a Safepay outage cannot release seats that were paid for.
      const due = await pool.query(
        `SELECT DISTINCT b.id FROM bookings b JOIN payments p ON p.booking_id = b.id
         WHERE b.status = 'pending' AND b.hold_expires_at <= now()
           AND p.gateway = 'safepay' AND p.status IN ('initiated', 'pending') AND p.gateway_txn_id IS NOT NULL
         LIMIT 50`,
      );
      for (const r of due.rows) await reconcileSafepayBooking(r.id);
      const { rows } = await pool.query('SELECT expire_stale_bookings() AS n');
      if (rows[0].n > 0) logger.info({ expired: rows[0].n }, 'Expired unpaid bookings');
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
