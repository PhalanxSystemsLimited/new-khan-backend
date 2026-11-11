import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { buildUpdate } from '../../utils/sql.js';
import { idParam, intId, phone, text, longText } from '../../utils/schemas.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];

// ---------------- Cities ----------------
router.get('/cities', async (_req, res) => {
  const { rows } = await query(
    `SELECT id, name, province, country FROM cities WHERE is_active ORDER BY name`,
  );
  res.json({ data: rows });
});

const citySchema = z
  .object({
    name: text(2, 80),
    province: text(2, 80).optional(),
    country: text(2, 80).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

router.post('/cities', ...admin, validate({ body: citySchema }), async (req, res) => {
  const b = req.valid.body;
  const city = await one(
    `INSERT INTO cities (name, province, country, is_active)
     VALUES ($1, $2, COALESCE($3, 'Pakistan'), COALESCE($4, TRUE)) RETURNING *`,
    [b.name, b.province ?? null, b.country ?? null, b.isActive ?? null],
  );
  res.status(201).json({ data: city });
});

router.patch('/cities/:id', ...admin, validate({ params: idParam, body: citySchema.partial() }), async (req, res) => {
  const { setSql, values } = buildUpdate(
    req.valid.body,
    { name: 'name', province: 'province', country: 'country', isActive: 'is_active' },
    2,
  );
  const city = await one(`UPDATE cities SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
  if (!city) throw AppError.notFound('City not found');
  res.json({ data: city });
});

// ---------------- Terminals ----------------
router.get(
  '/terminals',
  validate({ query: z.object({ cityId: intId.optional() }).strict() }),
  async (req, res) => {
    const { cityId } = req.valid.query;
    const { rows } = await query(
      `SELECT t.id, t.city_id, c.name AS city_name, t.name, t.code, t.address, t.phone, t.latitude, t.longitude
       FROM terminals t JOIN cities c ON c.id = t.city_id
       WHERE t.is_active AND ($1::int IS NULL OR t.city_id = $1)
       ORDER BY c.name, t.name`,
      [cityId ?? null],
    );
    res.json({ data: rows });
  },
);

const terminalSchema = z
  .object({
    cityId: intId,
    name: text(2, 120),
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/, 'Code: 2-10 letters, digits or hyphens'),
    address: longText(500).optional(),
    phone: phone.optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
    isActive: z.boolean().optional(),
    isOrigin: z.boolean().optional(), // Lahore, Multan: where a bus's round trip starts and ends
  })
  .strict();

const TERMINAL_COLS = {
  cityId: 'city_id',
  name: 'name',
  code: 'code',
  address: 'address',
  phone: 'phone',
  latitude: 'latitude',
  longitude: 'longitude',
  isActive: 'is_active',
  isOrigin: 'is_origin',
};

router.post('/terminals', ...admin, validate({ body: terminalSchema }), async (req, res) => {
  const b = req.valid.body;
  const t = await one(
    `INSERT INTO terminals (city_id, name, code, address, phone, latitude, longitude, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, TRUE)) RETURNING *`,
    [b.cityId, b.name, b.code, b.address ?? null, b.phone ?? null, b.latitude ?? null, b.longitude ?? null, b.isActive ?? null],
  );
  if (b.isOrigin !== undefined) Object.assign(t, await one(`UPDATE terminals SET is_origin = $2 WHERE id = $1 RETURNING is_origin`, [t.id, b.isOrigin]));
  res.status(201).json({ data: t });
});

router.patch(
  '/terminals/:id',
  ...admin,
  validate({ params: idParam, body: terminalSchema.partial() }),
  async (req, res) => {
    const { setSql, values } = buildUpdate(req.valid.body, TERMINAL_COLS, 2);
    const t = await one(`UPDATE terminals SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
    if (!t) throw AppError.notFound('Terminal not found');
    res.json({ data: t });
  },
);

export default router;
