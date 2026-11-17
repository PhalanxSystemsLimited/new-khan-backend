-- 2026-11-19: Cargo, stage 1 part 3: arrival at the destination terminal, handing over to the receiver, returns.
--
-- New columns on parcels:
--   arrived_at / arrived_by_name           the destination terminal ticked it off the arriving bus ("arrived")
--   delivered_at / delivered_terminal_id   handed over ("delivered")
--   collected_by_name / collected_by_cnic  who took it (always recorded)
--   collected_proof                        'receiver_cnic' (the receiver with their own CNIC) or 'slip' (someone with
--                                          the slip or a picture of it, who gives their own CNIC)
--   delivered_by / delivered_by_name       the staff member who handed it over
--   returned_at / returned_reason          not collected: returned to the sender ("returned")
-- A receiver-pays parcel gets paid_at / paid_terminal_id when the money is taken at collection.
--
-- Only adds columns and checks; nothing existing changes. Needs 2026-11-17-cargo.sql first. Safe to run more than once.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-19-cargo-arrival.sql)
BEGIN;

ALTER TABLE parcels ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS arrived_by_name VARCHAR(120);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS delivered_terminal_id INT REFERENCES terminals(id) ON DELETE SET NULL;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS collected_by_name VARCHAR(120);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS collected_by_cnic VARCHAR(15);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS collected_proof VARCHAR(15);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS delivered_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS delivered_by_name VARCHAR(120);
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE parcels ADD COLUMN IF NOT EXISTS returned_reason VARCHAR(300);

ALTER TABLE parcels DROP CONSTRAINT IF EXISTS parcels_proof_valid;
ALTER TABLE parcels ADD CONSTRAINT parcels_proof_valid CHECK (collected_proof IS NULL OR collected_proof IN ('receiver_cnic', 'slip'));
ALTER TABLE parcels DROP CONSTRAINT IF EXISTS parcels_delivered_complete;
ALTER TABLE parcels ADD CONSTRAINT parcels_delivered_complete CHECK (
    status <> 'delivered'
    OR (delivered_at IS NOT NULL AND collected_by_name IS NOT NULL AND collected_by_cnic IS NOT NULL AND collected_proof IS NOT NULL
        AND (payment = 'paid' OR paid_at IS NOT NULL))   -- a receiver-pays parcel is only handed over once paid
);
ALTER TABLE parcels DROP CONSTRAINT IF EXISTS parcels_returned_has_reason;
ALTER TABLE parcels ADD CONSTRAINT parcels_returned_has_reason CHECK (status <> 'returned' OR returned_reason IS NOT NULL);

-- Parcels waiting for collection at a terminal, oldest first.
CREATE INDEX IF NOT EXISTS parcels_collect_idx ON parcels (to_terminal_id, arrived_at) WHERE status = 'arrived';

COMMIT;
