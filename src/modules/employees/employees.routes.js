/**
 * Employee registration (IT/HR = admins).
 *   GET   /admin/employees                 list: search by ID, name, CNIC, phone; filter by designation, active
 *   GET   /admin/employees/next-code       the ID the next employee will get (only taken when saved)
 *   GET   /admin/employees/lists           departments, designations, licence types, issuing authorities
 *   POST  /admin/employees/lists/:list     add to a list;  PATCH /admin/employees/lists/:list/:id  rename, (de)activate
 *   GET   /admin/employees/team?kind=hostess|cashier   the Hostesses / Cashiers pages (same people, with their trips / reports)
 *   GET   /admin/employees/:id             one employee
 *   POST  /admin/employees                 register (the database assigns the ID)
 *   PATCH /admin/employees/:id             update
 *   PATCH /admin/employees/:id/login       link / unlink a sign-in account and set its role
 *   GET   /employees/crew?kind=hostess|cashier|driver|conductor   active people for dropdowns (managers and up)
 * Drivers and conductors used by trips are kept in step with their employee record (syncCrew).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES, MANAGER_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { cnic, intId, isoDate, longText, pagination, personName, phone, text, uuid } from '../../utils/schemas.js';

// ---------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------
const opt = (s) => s.nullable().optional();
const employeeFields = {
  fullName: personName,
  departmentId: opt(intId),
  designationId: intId,
  joiningDate: opt(isoDate),
  cnic: opt(cnic),
  cnicExpiry: opt(isoDate),
  maritalStatus: opt(z.enum(['single', 'married', 'widowed', 'divorced'])),
  currentAddress: opt(text(2, 300)),
  permanentAddress: opt(text(2, 300)),
  city: opt(text(2, 80)),
  phone: opt(phone),
  bloodGroup: opt(z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'])),
  licenceNo: opt(z.string().trim().toUpperCase().regex(/^[A-Z0-9/ -]{2,40}$/, 'Licence no.: letters, digits, / and -')),
  licenceTypeId: opt(intId),
  licenceExpiry: opt(isoDate),
  licenceAuthority: opt(text(2, 80)),
  notes: opt(longText(1000)),
  isActive: z.boolean().optional(),
  leftOn: opt(isoDate),
};
const createSchema = z.object(employeeFields).strict();
const updateSchema = z.object(employeeFields).partial().strict();

const COLS = {
  fullName: 'full_name', departmentId: 'department_id', designationId: 'designation_id', joiningDate: 'joining_date',
  cnic: 'cnic', cnicExpiry: 'cnic_expiry', maritalStatus: 'marital_status', currentAddress: 'current_address',
  permanentAddress: 'permanent_address', city: 'city', phone: 'phone', bloodGroup: 'blood_group', licenceNo: 'licence_no',
  licenceTypeId: 'licence_type_id', licenceExpiry: 'licence_expiry', licenceAuthority: 'licence_authority', notes: 'notes',
  isActive: 'is_active', leftOn: 'left_on',
};

const SELECT = `
  SELECT e.*, d.name AS department, g.name AS designation, g.crew, g.suggested_role, lt.name AS licence_type,
         u.email AS login_email, u.role::text AS login_role, u.terminal_id AS login_terminal_id,
         (e.licence_expiry IS NOT NULL AND e.licence_expiry < CURRENT_DATE) AS licence_expired,
         (e.licence_expiry IS NOT NULL AND e.licence_expiry >= CURRENT_DATE AND e.licence_expiry < CURRENT_DATE + 30) AS licence_expiring,
         (e.cnic_expiry IS NOT NULL AND e.cnic_expiry < CURRENT_DATE + 30) AS cnic_expiring,
         dr.id AS driver_id, cn.id AS conductor_id
  FROM employees e
  LEFT JOIN departments d ON d.id = e.department_id
  LEFT JOIN designations g ON g.id = e.designation_id
  LEFT JOIN licence_types lt ON lt.id = e.licence_type_id
  LEFT JOIN users u ON u.id = e.user_id
  LEFT JOIN drivers dr ON dr.employee_id = e.id
  LEFT JOIN conductors cn ON cn.employee_id = e.id`;

const loadEmployee = (id, client) => one(`${SELECT} WHERE e.id = $1`, [id], client);

/** Friendly messages for the unique rules. */
function unique(err) {
  if (err.code !== '23505') throw err;
  const c = err.constraint ?? '';
  if (c.includes('cnic')) throw AppError.conflict('Another employee (or driver / conductor) already has this CNIC.');
  if (c.includes('user')) throw AppError.conflict('That login account is already linked to another employee.');
  if (c.includes('license') || c.includes('licence')) throw AppError.conflict('Another driver already has this licence no.');
  throw AppError.conflict('This would duplicate another record.');
}

// ---------------------------------------------------------------------------------------------------------------
// Drivers and conductors used by trips follow their employee record
// ---------------------------------------------------------------------------------------------------------------
async function syncCrew(client, employeeId) {
  const e = await loadEmployee(employeeId, client);
  const active = e.isActive && !e.leftOn;

  const driver = await one(`SELECT id FROM drivers WHERE employee_id = $1`, [e.id], client);
  if (e.crew === 'driver') {
    if (!e.phone || !e.licenceNo || !e.licenceExpiry) {
      throw AppError.unprocessable('A driver needs a contact no., licence no. and licence expiry.');
    }
    if (driver) {
      await client.query(
        `UPDATE drivers SET full_name = $2, phone = $3, cnic = $4, license_no = $5, license_expiry = $6, is_active = $7 WHERE id = $1`,
        [driver.id, e.fullName, e.phone, e.cnic, e.licenceNo, e.licenceExpiry, active],
      );
    } else {
      await client.query(
        `INSERT INTO drivers (full_name, phone, cnic, license_no, license_expiry, is_active, employee_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [e.fullName, e.phone, e.cnic, e.licenceNo, e.licenceExpiry, active, e.id],
      );
    }
  } else if (driver) {
    await client.query(`UPDATE drivers SET is_active = FALSE WHERE id = $1`, [driver.id]);
  }

  const conductor = await one(`SELECT id FROM conductors WHERE employee_id = $1`, [e.id], client);
  if (e.crew === 'conductor') {
    if (!e.phone) throw AppError.unprocessable('A conductor needs a contact no.');
    if (conductor) {
      await client.query(
        `UPDATE conductors SET full_name = $2, phone = $3, cnic = $4, is_active = $5, user_id = $6 WHERE id = $1`,
        [conductor.id, e.fullName, e.phone, e.cnic, active, e.userId],
      );
    } else {
      await client.query(
        `INSERT INTO conductors (full_name, phone, cnic, is_active, user_id, employee_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [e.fullName, e.phone, e.cnic, active, e.userId, e.id],
      );
    }
  } else if (conductor) {
    await client.query(`UPDATE conductors SET is_active = FALSE WHERE id = $1`, [conductor.id]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------------------------------------------
export const adminEmployeesRouter = Router();
adminEmployeesRouter.use(requireAuth, requireRole(...ADMIN_ROLES));

adminEmployeesRouter.get(
  '/',
  validate({
    query: pagination
      .extend({
        q: z.string().trim().max(60).optional(),
        designationId: intId.optional(),
        status: z.enum(['active', 'left', 'all']).default('active'),
        expiring: z.enum(['true']).optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = `WHERE ($1::text IS NULL OR e.employee_code ILIKE '%' || $1 || '%' OR e.full_name ILIKE '%' || $1 || '%'
                          OR e.cnic LIKE '%' || $1 || '%' OR e.phone LIKE '%' || $1 || '%')
                     AND ($2::int IS NULL OR e.designation_id = $2)
                     AND ($3::text = 'all' OR ($3::text = 'active') = e.is_active)
                     AND (NOT $4::boolean OR (e.licence_expiry < CURRENT_DATE + 30 OR e.cnic_expiry < CURRENT_DATE + 30))`;
    const params = [q.q || null, q.designationId ?? null, q.status, Boolean(q.expiring)];
    const total = (await one(`SELECT count(*)::int AS n FROM employees e ${where}`, params)).n;
    const { rows } = await query(`${SELECT} ${where} ORDER BY e.employee_code LIMIT $5 OFFSET $6`, [...params, q.limit, (q.page - 1) * q.limit]);
    const warn = await one(
      `SELECT count(*) FILTER (WHERE licence_expiry < CURRENT_DATE + 30)::int AS licences,
              count(*) FILTER (WHERE cnic_expiry < CURRENT_DATE + 30)::int AS cnics
       FROM employees WHERE is_active`,
    );
    res.json({ data: rows, warnings: warn, pagination: { page: q.page, limit: q.limit, total, totalPages: Math.ceil(total / q.limit) } });
  },
);

adminEmployeesRouter.get('/next-code', async (_req, res) => {
  const r = await one(`SELECT 'NK-' || lpad((last_no + 1)::text, 5, '0') AS code FROM employee_counter WHERE id = 1`);
  res.set('Cache-Control', 'no-store');
  res.json({ data: { code: r?.code ?? 'NK-00001' } });
});

// ---- Lists ----
const LISTS = {
  departments: { table: 'departments', max: 60 },
  designations: { table: 'designations', max: 60 },
  'licence-types': { table: 'licence_types', max: 60 },
  'licence-authorities': { table: 'licence_authorities', max: 80 },
};
const listParam = z.enum(Object.keys(LISTS));

adminEmployeesRouter.get('/lists', async (_req, res) => {
  const [departments, designations, licenceTypes, authorities] = await Promise.all([
    query(`SELECT id, name, sort_order, is_active FROM departments ORDER BY sort_order, name`),
    query(`SELECT id, name, crew, suggested_role, sort_order, is_active FROM designations ORDER BY sort_order, name`),
    query(`SELECT id, name, sort_order, is_active FROM licence_types ORDER BY sort_order, name`),
    query(`SELECT id, name, sort_order, is_active FROM licence_authorities ORDER BY sort_order, name`),
  ]);
  res.json({ data: { departments: departments.rows, designations: designations.rows, licenceTypes: licenceTypes.rows, authorities: authorities.rows } });
});

adminEmployeesRouter.post('/lists/:list', validate({ params: z.object({ list: listParam }).strict(), body: z.object({ name: text(1, 80) }).strict() }), async (req, res) => {
  const { table, max } = LISTS[req.valid.params.list];
  if (req.valid.body.name.length > max) throw AppError.badRequest(`At most ${max} characters`);
  const row = await withTransaction(async (client) => {
    const r = await one(
      `INSERT INTO ${table} (name, sort_order) VALUES ($1, (SELECT COALESCE(max(sort_order), 0) + 1 FROM ${table})) RETURNING *`,
      [req.valid.body.name],
      client,
    );
    await audit({ req, client, action: `${table}.create`, entityType: 'employee_list', entityId: `${table}:${r.id}`, newData: r });
    return r;
  }).catch(unique);
  res.status(201).json({ data: row });
});

adminEmployeesRouter.patch(
  '/lists/:list/:id',
  validate({
    params: z.object({ list: listParam, id: intId }).strict(),
    body: z.object({ name: text(1, 80).optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().min(0).max(999).optional() }).strict(),
  }),
  async (req, res) => {
    const { table } = LISTS[req.valid.params.list];
    const b = req.valid.body;
    const row = await withTransaction(async (client) => {
      const before = await one(`SELECT * FROM ${table} WHERE id = $1 FOR UPDATE`, [req.valid.params.id], client);
      if (!before) throw AppError.notFound('Not found');
      const r = await one(
        `UPDATE ${table} SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), sort_order = COALESCE($4, sort_order) WHERE id = $1 RETURNING *`,
        [before.id, b.name ?? null, b.isActive ?? null, b.sortOrder ?? null],
        client,
      );
      await audit({ req, client, action: `${table}.update`, entityType: 'employee_list', entityId: `${table}:${before.id}`, oldData: before, newData: b });
      return r;
    }).catch(unique);
    res.json({ data: row });
  },
);

// ---- Employees ----
const idParam = z.object({ id: intId }).strict();

// ---- Hostesses / Cashiers (Fleet & people shortcuts) ----
// The employees whose designation feeds the hostess or cashier dropdown: the same people, not a separate list.
// Trips and round trip reports keep the person's NAME (as chosen in the dropdown), so they are matched by name,
// ignoring case and spaces around it.
const sameName = (col) => `lower(btrim(${col})) = lower(btrim(e.full_name))`;
const TEAM_EXTRA = {
  hostess: `
    (SELECT count(*)::int FROM trips t
      WHERE ${sameName('t.hostess_name')} AND t.status::text <> 'cancelled'
        AND t.departure_at >= now() AND t.departure_at < now() + interval '7 days') AS trips_next_7_days,
    (SELECT json_build_object('departureAt', t.departure_at, 'routeName', r.name, 'busNo', b.registration_no)
       FROM trips t JOIN routes r ON r.id = t.route_id JOIN buses b ON b.id = t.bus_id
      WHERE ${sameName('t.hostess_name')} AND t.status::text IN ('scheduled', 'delayed', 'boarding')
        AND t.departure_at >= now() - interval '2 hours'
      ORDER BY t.departure_at LIMIT 1) AS next_trip`,
  cashier: `
    (SELECT count(*)::int FROM round_trips rt
      WHERE ${sameName('rt.cashier_name')} AND rt.report_date >= CURRENT_DATE - 30) AS reports_last_30_days,
    (SELECT max(rt.report_date)::text FROM round_trips rt WHERE ${sameName('rt.cashier_name')}) AS last_report_date,
    (SELECT c.name || ' · ' || tm.name FROM terminals tm JOIN cities c ON c.id = tm.city_id WHERE tm.id = u.terminal_id) AS login_terminal`,
};

adminEmployeesRouter.get(
  '/team',
  validate({ query: z.object({ kind: z.enum(['hostess', 'cashier']), status: z.enum(['active', 'left', 'all']).default('active') }).strict() }),
  async (req, res) => {
    const { kind, status } = req.valid.query;
    const { rows } = await query(
      `SELECT e.id, e.employee_code, e.full_name, e.phone, e.is_active, e.left_on::text AS left_on, e.user_id,
              g.name AS designation, g.suggested_role,
              u.email AS login_email, u.role::text AS login_role, u.terminal_id AS login_terminal_id,
              ${TEAM_EXTRA[kind]}
       FROM employees e
       JOIN designations g ON g.id = e.designation_id
       LEFT JOIN users u ON u.id = e.user_id
       WHERE g.crew = $1 AND ($2::text = 'all' OR ($2::text = 'active') = e.is_active)
       ORDER BY e.is_active DESC, e.full_name`,
      [kind, status],
    );
    res.json({ data: rows });
  },
);

adminEmployeesRouter.get('/:id', validate({ params: idParam }), async (req, res) => {
  const e = await loadEmployee(req.valid.params.id);
  if (!e) throw AppError.notFound('Employee not found');
  res.json({ data: e });
});

adminEmployeesRouter.post('/', validate({ body: createSchema }), async (req, res) => {
  const b = req.valid.body;
  const made = await withTransaction(async (client) => {
    const fields = Object.keys(COLS).filter((k) => b[k] !== undefined);
    const cols = fields.map((k) => COLS[k]);
    const values = fields.map((k) => b[k]);
    // employee_code is assigned by the database (next_employee_code) only now, when the employee is saved.
    const row = await one(
      `INSERT INTO employees (employee_code, ${cols.join(', ')}, created_by)
       VALUES ('NK-00000', ${values.map((_, i) => `$${i + 1}`).join(', ')}, $${values.length + 1}) RETURNING id, employee_code`,
      [...values, req.user.id],
      client,
    );
    await syncCrew(client, row.id);
    await audit({ req, client, action: 'employee.create', entityType: 'employee', entityId: row.employeeCode, newData: b });
    return row;
  }).catch(unique);
  res.status(201).json({ data: await loadEmployee(made.id) });
});

adminEmployeesRouter.patch('/:id', validate({ params: idParam, body: updateSchema }), async (req, res) => {
  const b = req.valid.body;
  const id = req.valid.params.id;
  await withTransaction(async (client) => {
    const before = await one(`SELECT * FROM employees WHERE id = $1 FOR UPDATE`, [id], client);
    if (!before) throw AppError.notFound('Employee not found');
    const fields = Object.keys(COLS).filter((k) => b[k] !== undefined);
    if (!fields.length) throw AppError.badRequest('Nothing to change');
    await client.query(
      `UPDATE employees SET ${fields.map((k, i) => `${COLS[k]} = $${i + 2}`).join(', ')} WHERE id = $1`,
      [id, ...fields.map((k) => b[k])],
    );
    await syncCrew(client, id);
    const oldData = Object.fromEntries(fields.map((k) => [k, before[k]]));
    await audit({ req, client, action: 'employee.update', entityType: 'employee', entityId: before.employeeCode, oldData, newData: b });
  }).catch(unique);
  res.json({ data: await loadEmployee(id) });
});

/** Links (or unlinks) the employee's sign-in account and gives it a role. Manager and admin roles: super admins only. */
const LOGIN_ROLES = ['agent', 'driver', 'conductor', 'manager', 'admin'];
adminEmployeesRouter.patch(
  '/:id/login',
  validate({
    params: idParam,
    body: z.object({ userId: uuid.nullable(), role: z.enum(LOGIN_ROLES).optional(), terminalId: intId.nullable().optional() }).strict(),
  }),
  async (req, res) => {
    const id = req.valid.params.id;
    const { userId, role, terminalId } = req.valid.body;
    await withTransaction(async (client) => {
      const e = await one(`SELECT id, employee_code, user_id FROM employees WHERE id = $1 FOR UPDATE`, [id], client);
      if (!e) throw AppError.notFound('Employee not found');
      if (userId) {
        if (userId === req.user.id) throw AppError.forbidden('You cannot change your own account here.');
        const u = await one(`SELECT id, role::text FROM users WHERE id = $1 FOR UPDATE`, [userId], client);
        if (!u) throw AppError.notFound('Account not found');
        const newRole = role ?? u.role;
        const privileged = ['manager', 'admin', 'super_admin'];
        if ((privileged.includes(newRole) || privileged.includes(u.role)) && newRole !== u.role && req.user.role !== 'super_admin') {
          throw AppError.forbidden('Only a super admin can give or take away manager and admin roles.');
        }
        if (u.role === 'super_admin') throw AppError.forbidden('A super admin account cannot be linked here.');
        if (newRole === 'agent' && !terminalId) throw AppError.badRequest('Choose the terminal this counter staff member works at.');
        await client.query(`UPDATE users SET role = $2, terminal_id = $3 WHERE id = $1`, [
          userId, newRole, ['agent', 'manager'].includes(newRole) ? terminalId ?? null : null,
        ]);
      }
      await client.query(`UPDATE employees SET user_id = $2 WHERE id = $1`, [id, userId]);
      await syncCrew(client, id);
      await audit({ req, client, action: 'employee.login', entityType: 'employee', entityId: e.employeeCode, oldData: { userId: e.userId }, newData: { userId, role, terminalId } });
    }).catch(unique);
    res.json({ data: await loadEmployee(id) });
  },
);

// ---------------------------------------------------------------------------------------------------------------
// Dropdowns (Bus & crew, round trip reports)
// ---------------------------------------------------------------------------------------------------------------
export const crewRouter = Router();
crewRouter.get(
  '/crew',
  requireAuth,
  requireRole(...MANAGER_ROLES),
  validate({ query: z.object({ kind: z.enum(['driver', 'conductor', 'hostess', 'cashier']) }).strict() }),
  async (req, res) => {
    const { rows } = await query(
      `SELECT e.id, e.employee_code, e.full_name, e.phone FROM employees e JOIN designations g ON g.id = e.designation_id
       WHERE g.crew = $1 AND e.is_active AND e.left_on IS NULL ORDER BY e.full_name`,
      [req.valid.query.kind],
    );
    res.json({ data: rows });
  },
);
