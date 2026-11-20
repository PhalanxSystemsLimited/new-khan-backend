-- 2026-11-23: "Cargo staff" login role (role value 'cargo').
--
-- Cargo staff work at one terminal, like counter staff: they book parcels from it, load cargo onto the buses
-- leaving it, and receive / hand over parcels arriving there. Counter staff ('agent') no longer do cargo; they
-- only see a bus's cargo list read-only from the voucher page. Managers and admins keep both.
-- Also adds the designation "Cargo Staff" (Employee lists), which suggests this role when a login is linked.
--
-- Safe to run more than once. Nothing else changes.
-- Run: the Supabase SQL Editor (or node scripts/run-sql.js db/migrations/2026-11-23-cargo-staff.sql)

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'cargo' AFTER 'agent';

INSERT INTO designations (name, crew, suggested_role, sort_order)
SELECT 'Cargo Staff', NULL, 'cargo', 6
WHERE NOT EXISTS (SELECT 1 FROM designations WHERE lower(name) = 'cargo staff');
