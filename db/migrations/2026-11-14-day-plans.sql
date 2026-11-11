-- Day plan: the timetable of a day's trips (time, route and stops, bus, driver, conductor, hostess, seats sold) that
-- an admin or manager checks and PUBLISHES the day before, then shares as PDF (WhatsApp, notice board) and CSV (office).
--   * One row per published date; publishing again makes a new version.
--   * snapshot: the trips as published, so the plan page can mark what changed since (time, delay, bus, crew,
--     status, added or cancelled trips) and the admin knows to share an update.
-- Only adds a table. Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-14-day-plans.sql   (or the Supabase SQL Editor)
BEGIN;

CREATE TABLE IF NOT EXISTS day_plans (
    plan_date          DATE PRIMARY KEY,
    version            INT NOT NULL DEFAULT 1 CHECK (version > 0),
    published_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    published_by_name  VARCHAR(120) NOT NULL,
    snapshot           JSONB NOT NULL DEFAULT '[]'::jsonb
);
ALTER TABLE day_plans ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON day_plans FROM anon, authenticated;

COMMIT;
