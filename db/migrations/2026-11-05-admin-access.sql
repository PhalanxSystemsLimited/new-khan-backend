-- =====================================================================
--  Admin panel access: manual commands
--  Run in Supabase Dashboard -> SQL Editor.
--
--  Roles: 'customer' (no panel) | 'agent' (staff) | 'admin' | 'super_admin'
--  The account must already exist (the person signs up on the website first).
--
--  Normally only PART 1 is ever needed. After that, the super admin does
--  everything (hire, remove, hand over) from Admin panel -> Users & staff,
--  which also records each change in the Activity log. SQL changes are NOT
--  recorded there.
--
--  PARTS 2, 3 and 4 are commented out so running this whole file can't
--  change anyone by accident. To use one: replace the example emails,
--  remove the "--" from its lines, and run only that part.
-- =====================================================================


-- ---------------------------------------------------------------------
-- PART 1: Make YOURSELF the first super admin (run once)
-- ---------------------------------------------------------------------
UPDATE public.users
SET role = 'super_admin', is_active = true
WHERE lower(email) = lower('you@example.com');


-- ---------------------------------------------------------------------
-- PART 2 (backup only): Give admin panel access
-- Normal way: Users & staff -> find the person -> Role.
-- ---------------------------------------------------------------------
-- UPDATE public.users
-- SET role = 'agent'                  -- or 'admin'
-- WHERE lower(email) IN (
--     lower('person1@example.com'),
--     lower('person2@example.com')
-- );


-- ---------------------------------------------------------------------
-- PART 3 (backup only): Remove access from someone who left
-- Takes away admin panel access AND blocks the account, so they can't
-- sign in at all. Normal way: Users & staff -> Role -> Customer, then Block.
-- To let them back in later: set is_active = true and give back their role.
-- ---------------------------------------------------------------------
-- UPDATE public.users
-- SET role = 'customer', is_active = false
-- WHERE lower(email) = lower('ex.employee@example.com');


-- ---------------------------------------------------------------------
-- PART 4 (emergency only): Change the super admin
-- Use ONLY if the old super admin is gone or can't log in. Normal handover:
-- the old super admin makes the new person super admin in the panel, then
-- the new super admin removes the old one.
-- Both changes happen together or not at all.
-- ---------------------------------------------------------------------
-- BEGIN;
-- UPDATE public.users
-- SET role = 'super_admin', is_active = true
-- WHERE lower(email) = lower('new.boss@example.com');
--
-- UPDATE public.users
-- SET role = 'customer', is_active = false
-- WHERE lower(email) = lower('old.boss@example.com');
-- COMMIT;


-- ---------------------------------------------------------------------
-- CHECK: Who has admin panel access right now (changes nothing)
-- ---------------------------------------------------------------------
SELECT email, full_name, role, is_active
FROM public.users
WHERE role IN ('agent', 'admin', 'super_admin')
ORDER BY role, email;
