-- 2026-11-15: CNIC on every new booking, manager-approved refunds for older bookings, and SMS (off until set up).
--
--  1. refunds.identity_check gets a third value, 'manager': a booking made before CNICs were required has no CNIC
--     to check, so a manager or admin confirms the holder themselves (or, once SMS is on, a code is sent instead).
--  2. sms_messages: every SMS the server tries to send (number partly hidden, never the code itself).
--  3. phone_codes: one-time codes that verify a customer's mobile number before an online booking (SMS on only).
--  4. verified_phones: numbers a customer has verified, so they are asked only once per number.
--
-- The CNIC column on bookings stays nullable on purpose: bookings made before today have none. The server
-- refuses any NEW booking without one.
-- Safe to run more than once.

BEGIN;

-- 1. Manager-confirmed refunds
ALTER TABLE refunds DROP CONSTRAINT IF EXISTS refunds_identity_check_valid;
ALTER TABLE refunds ADD CONSTRAINT refunds_identity_check_valid
  CHECK (identity_check IS NULL OR identity_check IN ('cnic', 'sms_code', 'manager'));

-- 2. SMS log
CREATE TABLE IF NOT EXISTS sms_messages (
  id          BIGSERIAL PRIMARY KEY,
  to_masked   VARCHAR(20),
  kind        VARCHAR(30) NOT NULL,          -- booking_confirmed | phone_code | refund_code
  booking_id  UUID REFERENCES bookings(id) ON DELETE SET NULL,
  status      VARCHAR(10) NOT NULL CHECK (status IN ('sent', 'failed')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sms_messages_created_idx ON sms_messages (created_at DESC);
-- One confirmation SMS per booking, even if the payment is reported twice.
CREATE UNIQUE INDEX IF NOT EXISTS sms_messages_one_confirmation
  ON sms_messages (booking_id) WHERE kind = 'booking_confirmed' AND status = 'sent';

-- 3. Phone verification codes
CREATE TABLE IF NOT EXISTS phone_codes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone       VARCHAR(20) NOT NULL,
  code_hash   CHAR(64) NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_codes_user_idx ON phone_codes (user_id, created_at DESC);

-- 4. Verified numbers
CREATE TABLE IF NOT EXISTS verified_phones (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone        VARCHAR(20) NOT NULL,
  verified_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, phone)
);

-- Server-only tables: never readable through Supabase's public API.
ALTER TABLE sms_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE phone_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE verified_phones ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sms_messages, phone_codes, verified_phones FROM anon, authenticated;

COMMIT;
