-- Counter refunds and the booking holder's CNIC.
--   * Every new booking records the CNIC of its holder (the person who may cancel it and collect a refund).
--   * A refund is either 'online' (cancelled online, or paid online: the super admin approves it, the money goes
--     back through Safepay) or 'counter' (paid in cash and cancelled at a counter: paid out in cash on the spot).
--   * Before a counter refund, staff confirm the holder: their CNIC must match, or, for older bookings with no
--     CNIC, a one-time code is sent by SMS to the booking's phone number (refund_codes).
-- Same definitions as in db/schema.sql. Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-06-counter-refunds.sql
BEGIN;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS holder_cnic VARCHAR(13);   -- 13 digits, no dashes
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_holder_cnic_format;
ALTER TABLE bookings ADD CONSTRAINT bookings_holder_cnic_format CHECK (holder_cnic IS NULL OR holder_cnic ~ '^[0-9]{13}$');

ALTER TABLE refunds ADD COLUMN IF NOT EXISTS channel VARCHAR(10) NOT NULL DEFAULT 'online';
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS identity_check VARCHAR(10);
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_channel_valid;
ALTER TABLE refunds ADD CONSTRAINT refunds_channel_valid CHECK (channel IN ('online', 'counter'));
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_identity_check_valid;
ALTER TABLE refunds ADD CONSTRAINT refunds_identity_check_valid CHECK (identity_check IS NULL OR identity_check IN ('cnic', 'sms_code'));

CREATE TABLE IF NOT EXISTS refund_codes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id      UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    code_hash       CHAR(64) NOT NULL,                 -- sha256 of booking id + code; the code itself is never stored
    sent_to         VARCHAR(20) NOT NULL,
    requested_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    attempts        SMALLINT NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS refund_codes_booking_idx ON refund_codes (booking_id, created_at DESC);
ALTER TABLE refund_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON refund_codes FROM anon, authenticated;

COMMIT;
