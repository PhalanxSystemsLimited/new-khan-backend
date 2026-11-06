-- Keep seats for a booking whose customer opened a Safepay checkout up to 20 minutes past the hold,
-- so the expiry job can ask Safepay whether it was paid before the seats are released.
-- Same definition as in db/schema.sql. Run: node scripts/run-sql.js db/migrations/2026-11-05-safepay-expiry-grace.sql
CREATE OR REPLACE FUNCTION expire_stale_bookings()
RETURNS INT LANGUAGE plpgsql SET search_path = public AS $$
DECLARE n INT;
BEGIN
    UPDATE bookings b SET status = 'expired'
    WHERE b.status = 'pending' AND b.hold_expires_at IS NOT NULL AND b.hold_expires_at < now()
      AND (b.hold_expires_at < now() - interval '20 minutes'
           OR NOT EXISTS (SELECT 1 FROM payments p
                          WHERE p.booking_id = b.id AND p.gateway = 'safepay'
                            AND p.status IN ('initiated', 'pending') AND p.gateway_txn_id IS NOT NULL));
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$;
