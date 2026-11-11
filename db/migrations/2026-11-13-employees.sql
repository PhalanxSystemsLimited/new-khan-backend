-- Employee registration (IT/HR registers every member of staff when hiring them).
--   * employees: one record per person. Employee ID NK-00001, NK-00002... assigned by the database only when the
--     employee is saved (a counter row, locked per insert: unique, never reused, no gaps from abandoned forms).
--   * CNIC unique. Licence details for drivers. Departments, designations, licence types and issuing authorities
--     are lists admins can extend.
--   * Drivers and conductors stay where trips use them; each is linked to its employee (drivers.employee_id,
--     conductors.employee_id) and kept in step with it by the backend. Existing drivers, conductors and staff
--     directory entries become employees here.
--   * New login role 'driver' (optional: drivers with a smartphone see their trips).
-- Only adds (and links existing records). Safe to re-run.
-- Run: node scripts/run-sql.js db/migrations/2026-11-13-employees.sql   (or the Supabase SQL Editor)

-- New enum values must be committed before anything uses them.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'driver' BEFORE 'conductor';

BEGIN;

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Lists
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_name_uq ON departments (lower(name));

-- crew: where the system uses people of this designation (Bus & crew, round trip reports).
-- suggested_role: the login role offered when an account is linked (the admin decides).
CREATE TABLE IF NOT EXISTS designations (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(60) NOT NULL,
    crew            VARCHAR(12),
    suggested_role  VARCHAR(20),
    sort_order      SMALLINT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT designations_crew_valid CHECK (crew IS NULL OR crew IN ('driver', 'conductor', 'hostess', 'cashier'))
);
CREATE UNIQUE INDEX IF NOT EXISTS designations_name_uq ON designations (lower(name));

CREATE TABLE IF NOT EXISTS licence_types (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(60) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS licence_types_name_uq ON licence_types (lower(name));

CREATE TABLE IF NOT EXISTS licence_authorities (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(80) NOT NULL,
    sort_order  SMALLINT NOT NULL DEFAULT 0,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE UNIQUE INDEX IF NOT EXISTS licence_authorities_name_uq ON licence_authorities (lower(name));

INSERT INTO departments (name, sort_order) VALUES ('Operational Staff', 1) ON CONFLICT DO NOTHING;

INSERT INTO designations (name, crew, suggested_role, sort_order) VALUES
    ('GM', NULL, 'manager', 1),
    ('AGM', NULL, 'manager', 2),
    ('Stand Manager (SM)', NULL, 'manager', 3),
    ('ASM', NULL, 'manager', 4),
    ('Booking Officer', NULL, 'agent', 5),
    ('Loader', NULL, NULL, 6),
    ('Driver', 'driver', 'driver', 7),
    ('Conductor / Fare Collector', 'conductor', 'conductor', 8),
    ('Hostess', 'hostess', NULL, 9),
    ('Cashier', 'cashier', 'agent', 10)
ON CONFLICT DO NOTHING;

INSERT INTO licence_types (name, sort_order) VALUES
    ('HPSV (Heavy Passenger Service Vehicle)', 1), ('HTV (Heavy Transport Vehicle)', 2),
    ('LPSV (Light Passenger Service Vehicle)', 3), ('LTV (Light Transport Vehicle)', 4),
    ('Motor Car / Jeep', 5), ('Other', 6)
ON CONFLICT DO NOTHING;

INSERT INTO licence_authorities (name, sort_order) VALUES
    ('Punjab (DLIMS / Traffic Police)', 1), ('Islamabad (ITP)', 2), ('Sindh', 3), ('Khyber Pakhtunkhwa', 4),
    ('Balochistan', 5), ('Gilgit-Baltistan', 6), ('Azad Jammu & Kashmir', 7), ('Motorway Police (NHMP)', 8), ('Other', 9)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Employees
-- ---------------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employee_counter (
    id       SMALLINT PRIMARY KEY CHECK (id = 1),
    last_no  INT NOT NULL CHECK (last_no < 99999)
);
INSERT INTO employee_counter (id, last_no) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

/** Next employee ID. The counter row stays locked until the saving transaction ends: unique, and a cancelled save
    gives its number back, so opening and closing the form never uses one up. */
CREATE OR REPLACE FUNCTION next_employee_code()
RETURNS TEXT LANGUAGE sql VOLATILE SET search_path = public AS $$
    UPDATE employee_counter SET last_no = last_no + 1 WHERE id = 1 RETURNING 'NK-' || lpad(last_no::TEXT, 5, '0');
$$;

CREATE TABLE IF NOT EXISTS employees (
    id                  SERIAL PRIMARY KEY,
    employee_code       VARCHAR(10) NOT NULL,
    full_name           VARCHAR(120) NOT NULL,
    department_id       INT REFERENCES departments(id) ON DELETE SET NULL,
    designation_id      INT REFERENCES designations(id) ON DELETE SET NULL,
    joining_date        DATE,
    cnic                VARCHAR(15),
    cnic_expiry         DATE,
    marital_status      VARCHAR(10),
    current_address     VARCHAR(300),
    permanent_address   VARCHAR(300),
    city                VARCHAR(80),
    phone               VARCHAR(20),
    blood_group         VARCHAR(3),
    licence_no          VARCHAR(40),
    licence_type_id     INT REFERENCES licence_types(id) ON DELETE SET NULL,
    licence_expiry      DATE,
    licence_authority   VARCHAR(80),
    notes               VARCHAR(1000),
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,      -- their login, if they have one
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    left_on             DATE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT employees_code_uq UNIQUE (employee_code),
    CONSTRAINT employees_code_format CHECK (employee_code ~ '^NK-[0-9]{5}$'),
    CONSTRAINT employees_marital_valid CHECK (marital_status IS NULL OR marital_status IN ('single', 'married', 'widowed', 'divorced')),
    CONSTRAINT employees_blood_valid CHECK (blood_group IS NULL OR blood_group IN ('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'))
);
CREATE UNIQUE INDEX IF NOT EXISTS employees_cnic_uq ON employees (cnic) WHERE cnic IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS employees_user_uq ON employees (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS employees_name_idx ON employees (lower(full_name));
CREATE INDEX IF NOT EXISTS employees_designation_idx ON employees (designation_id, is_active);

CREATE OR REPLACE FUNCTION set_employee_code()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    NEW.employee_code := next_employee_code();   -- always system-generated
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS employees_set_code ON employees;
CREATE TRIGGER employees_set_code BEFORE INSERT ON employees FOR EACH ROW EXECUTE FUNCTION set_employee_code();

CREATE OR REPLACE FUNCTION keep_employee_code()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW.employee_code IS DISTINCT FROM OLD.employee_code THEN
        RAISE EXCEPTION 'An employee ID cannot be changed';
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS employees_keep_code ON employees;
CREATE TRIGGER employees_keep_code BEFORE UPDATE OF employee_code ON employees FOR EACH ROW EXECUTE FUNCTION keep_employee_code();

DROP TRIGGER IF EXISTS employees_set_updated_at ON employees;
CREATE TRIGGER employees_set_updated_at BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Drivers and conductors used by trips, linked to their employee.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS employee_id INT REFERENCES employees(id) ON DELETE SET NULL;
ALTER TABLE conductors ADD COLUMN IF NOT EXISTS employee_id INT REFERENCES employees(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS drivers_employee_uq ON drivers (employee_id) WHERE employee_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS conductors_employee_uq ON conductors (employee_id) WHERE employee_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Existing drivers, conductors and staff directory become employees (each once).
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE
    r        RECORD;
    v_id     INT;
    v_dept   INT := (SELECT id FROM departments WHERE lower(name) = 'operational staff');
    v_cnic   TEXT;
    v_note   TEXT;
BEGIN
    FOR r IN SELECT * FROM drivers WHERE employee_id IS NULL ORDER BY id LOOP
        v_cnic := r.cnic; v_note := 'Moved from the Drivers list.';
        IF v_cnic IS NOT NULL AND EXISTS (SELECT 1 FROM employees WHERE cnic = v_cnic) THEN
            v_note := v_note || ' CNIC ' || v_cnic || ' is already on another employee: please check.'; v_cnic := NULL;
        END IF;
        INSERT INTO employees (employee_code, full_name, department_id, designation_id, cnic, phone, licence_no, licence_expiry,
                               licence_type_id, is_active, notes)
        VALUES ('NK-00000', r.full_name, v_dept, (SELECT id FROM designations WHERE name = 'Driver'), v_cnic, r.phone, r.license_no,
                r.license_expiry, (SELECT id FROM licence_types WHERE name LIKE 'HPSV%'), r.is_active, v_note)
        RETURNING id INTO v_id;
        UPDATE drivers SET employee_id = v_id WHERE id = r.id;
    END LOOP;

    FOR r IN SELECT * FROM conductors WHERE employee_id IS NULL ORDER BY id LOOP
        v_cnic := r.cnic; v_note := 'Moved from the Conductors list.';
        IF v_cnic IS NOT NULL AND EXISTS (SELECT 1 FROM employees WHERE cnic = v_cnic) THEN
            v_note := v_note || ' CNIC ' || v_cnic || ' is already on another employee: please check.'; v_cnic := NULL;
        END IF;
        INSERT INTO employees (employee_code, full_name, department_id, designation_id, cnic, phone, user_id, is_active, notes)
        VALUES ('NK-00000', r.full_name, v_dept, (SELECT id FROM designations WHERE name = 'Conductor / Fare Collector'), v_cnic, r.phone,
                CASE WHEN r.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM employees WHERE user_id = r.user_id) THEN r.user_id END,
                r.is_active, v_note)
        RETURNING id INTO v_id;
        UPDATE conductors SET employee_id = v_id WHERE id = r.id;
    END LOOP;

    -- Staff directory (cleaners, loaders...): loaders keep their designation, others are noted for HR to set.
    FOR r IN SELECT * FROM staff_directory s
             WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.notes LIKE '%[staff directory #' || s.id || ']%') ORDER BY id LOOP
        v_cnic := r.cnic;
        IF v_cnic IS NOT NULL AND EXISTS (SELECT 1 FROM employees WHERE cnic = v_cnic) THEN v_cnic := NULL; END IF;
        INSERT INTO employees (employee_code, full_name, department_id, designation_id, cnic, phone, is_active, notes)
        VALUES ('NK-00000', r.full_name, v_dept, CASE WHEN r.job = 'loader' THEN (SELECT id FROM designations WHERE name = 'Loader') END,
                v_cnic, r.phone, r.is_active,
                'Moved from the Staff directory (job: ' || r.job || ') [staff directory #' || r.id || '].' || COALESCE(' ' || r.notes, ''));
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Security: only the backend reads and writes these tables.
-- ---------------------------------------------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['departments','designations','licence_types','licence_authorities','employee_counter','employees'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON %I FROM anon, authenticated', t);
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION next_employee_code() FROM anon, authenticated, public;

COMMIT;
