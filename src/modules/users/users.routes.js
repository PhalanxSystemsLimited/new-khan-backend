import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { buildUpdate, offsetOf, paged } from '../../utils/sql.js';
import { cnic, gender, isoDate, pagination, personName, phone, text, uuidParam, boolQuery } from '../../utils/schemas.js';

const router = Router();

const PROFILE_COLUMNS = `id, full_name, email, phone, role, cnic, gender, date_of_birth,
  is_active, email_verified, phone_verified, last_login_at, created_at, updated_at`;

router.get('/me', requireAuth, async (req, res) => {
  const user = await one(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = $1`, [req.user.id]);
  res.json({ data: user });
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

// Role, email and active flag are deliberately NOT updatable here.
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
  res.json({ data: user });
});

// ---------------- Admin ----------------
router.get(
  '/',
  requireAuth,
  requireRole(...ADMIN_ROLES),
  validate({
    query: pagination
      .extend({
        role: z.enum(['customer', 'agent', 'admin', 'super_admin']).optional(),
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
      `SELECT ${PROFILE_COLUMNS} FROM users ${whereSql}
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
    body: z.object({ role: z.enum(['customer', 'agent', 'admin', 'super_admin']) }).strict(),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { role } = req.valid.body;
    if (id === req.user.id) throw AppError.forbidden('You cannot change your own role');

    const target = await one(`SELECT id, role FROM users WHERE id = $1`, [id]);
    if (!target) throw AppError.notFound('User not found');

    // Only super_admin may grant or revoke admin-level roles.
    const touchesAdmin = ADMIN_ROLES.includes(role) || ADMIN_ROLES.includes(target.role);
    if (touchesAdmin && req.user.role !== 'super_admin') {
      throw AppError.forbidden('Only a super admin can manage admin accounts');
    }

    const user = await one(`UPDATE users SET role = $2 WHERE id = $1 RETURNING ${PROFILE_COLUMNS}`, [id, role]);
    await audit({ req, action: 'user.role_change', entityType: 'user', entityId: id, oldData: { role: target.role }, newData: { role } });
    res.json({ data: user });
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
    if (ADMIN_ROLES.includes(target.role) && req.user.role !== 'super_admin') {
      throw AppError.forbidden('Only a super admin can manage admin accounts');
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
