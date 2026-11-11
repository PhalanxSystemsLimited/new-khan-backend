import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES, EMPLOYEE_ROLES, MANAGER_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { buildUpdate, offsetOf, paged } from '../../utils/sql.js';
import { cnic, gender, intId, isoDate, pagination, personName, phone, text, uuidParam, boolQuery } from '../../utils/schemas.js';

const router = Router();

const PROFILE_COLUMNS = `id, full_name, email, phone, role, cnic, gender, date_of_birth, terminal_id,
  is_active, email_verified, phone_verified, last_login_at, created_at, updated_at`;

/** Every role, in order. 'agent' is shown as "Counter staff". */
const ROLES = ['customer', 'agent', 'driver', 'conductor', 'manager', 'admin', 'super_admin'];
/** Roles only a super admin may give or take away. */
const PRIVILEGED = ['manager', 'admin', 'super_admin'];

/** Adds the name of the terminal a staff member works at. */
async function withTerminal(user) {
  if (!user) return user;
  if (!user.terminalId) return { ...user, terminalName: null };
  const t = await one(`SELECT c.name AS city, t.name FROM terminals t JOIN cities c ON c.id = t.city_id WHERE t.id = $1`, [user.terminalId]);
  return { ...user, terminalName: t ? `${t.city} · ${t.name}` : null };
}

router.get('/me', requireAuth, async (req, res) => {
  const user = await one(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
  res.json({ data: await withTerminal(user) });
});

const updateMeSchema = z
  .object({
    fullName: personName.optional(),
    phone: phone.optional(),
    cnic: cnic.nullable().optional(),
    gender: gender.nullable().optional(),
    dateOfBirth: isoDate.nullable().optional(),
  })
  .strict();

// Role, terminal, email and active flag are deliberately NOT updatable here.
router.patch('/me', requireAuth, validate({ body: updateMeSchema }), async (req, res) => {
  const { setSql, values } = buildUpdate(
    req.valid.body,
    { fullName: 'full_name', phone: 'phone', cnic: 'cnic', gender: 'gender', dateOfBirth: 'date_of_birth' },
    2,
  );
  const user = await one(`UPDATE users SET ${setSql} WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`, [
    req.user.id,
    ...values,
  ]);
  res.json({ data: await withTerminal(user) });
});

// ---------------- Admin ----------------
/** Active staff accounts (every role except customer), for pickers such as the stand-in conductor. */
router.get('/staff', requireAuth, requireRole(...MANAGER_ROLES), async (_req, res) => {
  const { rows } = await query(
    `SELECT id, full_name, email, phone, role, terminal_id FROM users
     WHERE role::text = ANY ($1::text[]) AND is_active ORDER BY full_name`,
    [EMPLOYEE_ROLES],
  );
  res.json({ data: rows });
});

router.get(
  '/',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({
    query: pagination
      .extend({
        role: z.enum(ROLES).optional(),
        search: text(1, 100).optional(),
        isActive: boolQuery.optional(),
      })
      .strict(),
  }),
  async (req, res) => {
    const q = req.valid.query;
    const where = [];
    const params = [];
    if (q.role) {
      params.push(q.role);
      where.push(`role = $${params.length}`);
    }
    if (q.isActive !== undefined) {
      params.push(q.isActive);
      where.push(`is_active = $${params.length}`);
    }
    if (q.search) {
      params.push(`%${q.search.replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(full_name ILIKE $${params.length} OR email ILIKE $${params.length} OR phone ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (await one(`SELECT count(*)::int AS n FROM users ${whereSql}`, params)).n;
    params.push(q.limit, offsetOf(q));
    const { rows } = await query(
      `SELECT ${PROFILE_COLUMNS},
              (SELECT c.name || ' · ' || t.name FROM terminals t JOIN cities c ON c.id = t.city_id
               WHERE t.id = users.terminal_id) AS terminal_name
       FROM users ${whereSql}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json(paged(rows, q, total));
  },
);

router.patch(
  '/:id/role',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({
    params: uuidParam,
    // terminalId: where a counter staff member works (required for counter staff, optional for managers).
    body: z.object({ role: z.enum(ROLES), terminalId: intId.nullable().optional() }).strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { role } = req.valid.body;
    if (id === req.user.id) throw AppError.forbidden('You cannot change your own role');

    const target = await one(`SELECT id, role, terminal_id FROM users WHERE id = $1`, [id]);
    if (!target) throw AppError.notFound('User not found');

    // Only a super admin may give or take away manager and admin roles.
    const touchesPrivileged = PRIVILEGED.includes(role) || PRIVILEGED.includes(target.role);
    if (touchesPrivileged && req.user.role !== 'super_admin') {
      throw AppError.forbidden('Only a super admin can manage manager and admin accounts');
    }

    let terminalId = req.valid.body.terminalId !== undefined ? req.valid.body.terminalId : target.terminalId;
    if (!['agent', 'manager'].includes(role)) terminalId = null; // only counter staff and managers work at a terminal
    if (role === 'agent' && !terminalId) throw AppError.badRequest('Choose the terminal this counter staff member works at.');
    if (terminalId) {
      const t = await one(`SELECT id FROM terminals WHERE id = $1 AND is_active`, [terminalId]);
      if (!t) throw AppError.badRequest('Terminal not found or inactive');
    }

    const user = await one(`UPDATE users SET role = $2, terminal_id = $3 WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`, [id, role, terminalId]);
    await audit({
      req, action: 'user.role_change', entityType: 'user', entityId: id,
      oldData: { role: target.role, terminalId: target.terminalId }, newData: { role, terminalId },
    });
    res.json({ data: await withTerminal(user) });
  },
);

router.patch(
  '/:id/status',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({ params: uuidParam, body: z.object({ isActive: z.boolean() }).strict() }),
  async (req, res) => {
    const { id } = req.valid.params;
    if (id === req.user.id) throw AppError.forbidden('You cannot deactivate yourself');
    const target = await one(`SELECT role FROM users WHERE id = $1`, [id]);
    if (!target) throw AppError.notFound('User not found');
    if (PRIVILEGED.includes(target.role) && req.user.role !== 'super_admin') {
      throw AppError.forbidden('Only a super admin can manage manager and admin accounts');
    }
    const user = await one(`UPDATE users SET is_active = $2 WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`, [
      id,
      req.valid.body.isActive,
    ]);
    await audit({ req, action: 'user.status_change', entityType: 'user', entityId: id, newData: req.valid.body });
    res.json({ data: user });
  },
);

export default router;
