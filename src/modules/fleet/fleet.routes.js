import { Router } from 'express';
import { z } from 'zod';
import { query, one, withTransaction } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES, STAFF_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';
import { buildUpdate } from '../../utils/sql.js';
import { busClass, cnic, idParam, intId, isoDate, personName, phone, text } from '../../utils/schemas.js';

const router = Router();
const admin = [requireAuth, requireRole(...ADMIN_ROLES)];
const staff = [requireAuth, requireRole(...STAFF_ROLES)];

// ======================= Seat layouts =======================
const seatSchema = z
  .object({
    seatNumber: z.string().trim().regex(/^[A-Za-z0-9]{1,6}$/),
    rowNo: z.number().int().min(1).max(30),
    colNo: z.number().int().min(1).max(8),
    deck: z.number().int().min(1).max(2).default(1),
    kind: z.enum(['standard', 'window', 'aisle', 'sleeper', 'driver', 'blocked']).default('standard'),
    isBookable: z.boolean().default(true),
  })
  .strict();

const layoutSchema = z
  .object({
    name: text(3, 80),
    rowCount: z.number().int().min(1).max(30),
    colCount: z.number().int().min(1).max(8),
    decks: z.number().int().min(1).max(2).default(1),
    seats: z.array(seatSchema).min(1).max(120),
  })
  .strict()
  .superRefine((l, ctx) => {
    const nums = new Set();
    const pos = new Set();
    for (const s of l.seats) {
      if (nums.has(s.seatNumber)) ctx.addIssue({ code: 'custom', message: `Duplicate seat number ${s.seatNumber}` });
      const p = `${s.deck}-${s.rowNo}-${s.colNo}`;
      if (pos.has(p)) ctx.addIssue({ code: 'custom', message: `Two seats share position ${p}` });
      if (s.rowNo > l.rowCount || s.colNo > l.colCount || s.deck > l.decks) {
        ctx.addIssue({ code: 'custom', message: `Seat ${s.seatNumber} is outside the layout grid` });
      }
      nums.add(s.seatNumber);
      pos.add(p);
    }
  });

router.get('/layouts', ...staff, async (_req, res) => {
  const { rows } = await query(`SELECT * FROM seat_layouts ORDER BY name`);
  res.json({ data: rows });
});

router.get('/layouts/:id', ...staff, validate({ params: idParam }), async (req, res) => {
  const layout = await one(`SELECT * FROM seat_layouts WHERE id = $1`, [req.valid.params.id]);
  if (!layout) throw AppError.notFound('Layout not found');
  const { rows: seats } = await query(
    `SELECT id, seat_number, row_no, col_no, deck, kind, is_bookable
     FROM layout_seats WHERE layout_id = $1 ORDER BY deck, row_no, col_no`,
    [layout.id],
  );
  res.json({ data: { ...layout, seats } });
});

router.post('/layouts', ...admin, validate({ body: layoutSchema }), async (req, res) => {
  const b = req.valid.body;
  const layout = await withTransaction(async (client) => {
    const l = await one(
      `INSERT INTO seat_layouts (name, total_seats, row_count, col_count, decks) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [b.name, b.seats.length, b.rowCount, b.colCount, b.decks],
      client,
    );
    for (const s of b.seats) {
      await client.query(
        `INSERT INTO layout_seats (layout_id, seat_number, row_no, col_no, deck, kind, is_bookable)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [l.id, s.seatNumber, s.rowNo, s.colNo, s.deck, s.kind, s.isBookable && !['driver', 'blocked'].includes(s.kind)],
      );
    }
    return l;
  });
  res.status(201).json({ data: layout });
});

/** Make an individual seat bookable or not (layout geometry is immutable). */
router.patch(
  '/layouts/:id/seats/:seatId',
  ...admin,
  validate({
    params: z.object({ id: intId, seatId: intId }).strict(),
    body: z.object({ isBookable: z.boolean() }).strict(),
  }),
  async (req, res) => {
    const { setSql, values } = buildUpdate(req.valid.body, { isBookable: 'is_bookable' }, 3);
    const seat = await one(
      `UPDATE layout_seats SET ${setSql} WHERE id = $2 AND layout_id = $1 RETURNING *`,
      [req.valid.params.id, req.valid.params.seatId, ...values],
    );
    if (!seat) throw AppError.notFound('Seat not found');
    res.json({ data: seat });
  },
);

// ======================= Buses =======================
const amenity = z.enum(['ac', 'wifi', 'charging', 'snacks', 'lcd', 'washroom', 'blanket', 'water', 'gps']);

const busSchema = z
  .object({
    registrationNo: z.string().trim().toUpperCase().regex(/^[A-Z0-9 -]{3,20}$/),
    fleetNo: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{1,20}$/).optional(),
    layoutId: intId,
    busClass,
    make: text(1, 60).optional(),
    model: text(1, 60).optional(),
    manufactureYear: z.number().int().min(1980).max(2100).optional(),
    amenities: z.array(amenity).max(20).default([]),
    hasHostess: z.boolean().optional(), // off-route "Daily hostess" applies only to these buses
    isActive: z.boolean().optional(),
  })
  .strict();

const BUS_COLS = {
  registrationNo: 'registration_no',
  fleetNo: 'fleet_no',
  layoutId: 'layout_id',
  busClass: 'bus_class',
  make: 'make',
  model: 'model',
  manufactureYear: 'manufacture_year',
  amenities: 'amenities',
  hasHostess: 'has_hostess',
  isActive: 'is_active',
};

router.get('/buses', ...staff, async (_req, res) => {
  const { rows } = await query(
    `SELECT b.*, l.name AS layout_name, l.total_seats FROM buses b JOIN seat_layouts l ON l.id = b.layout_id ORDER BY b.fleet_no NULLS LAST, b.id`,
  );
  res.json({ data: rows });
});

router.post('/buses', ...admin, validate({ body: busSchema }), async (req, res) => {
  const b = req.valid.body;
  const bus = await one(
    `INSERT INTO buses (registration_no, fleet_no, layout_id, bus_class, make, model, manufacture_year, amenities, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, COALESCE($9, TRUE)) RETURNING *`,
    [b.registrationNo, b.fleetNo ?? null, b.layoutId, b.busClass, b.make ?? null, b.model ?? null,
      b.manufactureYear ?? null, JSON.stringify([...new Set(b.amenities)]), b.isActive ?? null],
  );
  // Separate statement: has_hostess only exists after db/migrations/2026-11-07-round-trip-reports.sql.
  if (b.hasHostess !== undefined) {
    Object.assign(bus, await one(`UPDATE buses SET has_hostess = $2 WHERE id = $1 RETURNING has_hostess`, [bus.id, b.hasHostess]));
  }
  res.status(201).json({ data: bus });
});

router.patch('/buses/:id', ...admin, validate({ params: idParam, body: busSchema.partial() }), async (req, res) => {
  const body = { ...req.valid.body };
  if (body.amenities) body.amenities = JSON.stringify([...new Set(body.amenities)]);
  if (body.layoutId !== undefined) {
    const future = await one(
      `SELECT EXISTS (SELECT 1 FROM trips t JOIN tickets tk ON tk.trip_id = t.id
                      WHERE t.bus_id = $1 AND t.departure_at > now()
                        AND tk.status IN ('held','reserved','confirmed')) AS x`,
      [req.valid.params.id],
    );
    if (future.x) throw AppError.conflict('Cannot change layout while future trips on this bus have bookings');
  }
  const { setSql, values } = buildUpdate(body, BUS_COLS, 2);
  const bus = await one(`UPDATE buses SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
  if (!bus) throw AppError.notFound('Bus not found');
  res.json({ data: bus });
});

// ======================= Drivers =======================
const driverSchema = z
  .object({
    fullName: personName,
    phone,
    cnic: cnic.optional(),
    licenseNo: z.string().trim().toUpperCase().regex(/^[A-Z0-9/-]{4,40}$/),
    licenseExpiry: isoDate,
    isActive: z.boolean().optional(),
  })
  .strict();

const DRIVER_COLS = {
  fullName: 'full_name',
  phone: 'phone',
  cnic: 'cnic',
  licenseNo: 'license_no',
  licenseExpiry: 'license_expiry',
  isActive: 'is_active',
};

router.get('/drivers', ...staff, async (_req, res) => {
  const { rows } = await query(
    `SELECT *, (license_expiry < CURRENT_DATE) AS license_expired FROM drivers ORDER BY full_name`,
  );
  res.json({ data: rows });
});

router.post('/drivers', ...admin, validate({ body: driverSchema }), async (req, res) => {
  const d = req.valid.body;
  const driver = await one(
    `INSERT INTO drivers (full_name, phone, cnic, license_no, license_expiry, is_active)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE)) RETURNING *`,
    [d.fullName, d.phone, d.cnic ?? null, d.licenseNo, d.licenseExpiry, d.isActive ?? null],
  );
  res.status(201).json({ data: driver });
});

router.patch('/drivers/:id', ...admin, validate({ params: idParam, body: driverSchema.partial() }), async (req, res) => {
  const { setSql, values } = buildUpdate(req.valid.body, DRIVER_COLS, 2);
  const driver = await one(`UPDATE drivers SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
  if (!driver) throw AppError.notFound('Driver not found');
  res.json({ data: driver });
});

// ======================= Conductors (with an optional login account) =======================
const conductorSchema = z
  .object({
    fullName: personName,
    phone,
    cnic: cnic.optional(),
    userId: z.string().uuid().nullable().optional(), // the conductor's login (an account with the Conductor role)
    isActive: z.boolean().optional(),
  })
  .strict();

const CONDUCTOR_COLS = { fullName: 'full_name', phone: 'phone', cnic: 'cnic', userId: 'user_id', isActive: 'is_active' };

async function assertConductorLogin(userId) {
  if (!userId) return;
  const u = await one(`SELECT role FROM users WHERE id = $1`, [userId]);
  if (!u) throw AppError.badRequest('Login account not found');
  if (u.role !== 'conductor') throw AppError.unprocessable('Give that account the Conductor role first (Users & staff).');
}

const uniqueConductor = (err) => {
  if (err.code === '23505') throw AppError.conflict('Another conductor already has this CNIC or login account.');
  throw err;
};

router.get('/conductors', ...staff, async (_req, res) => {
  const { rows } = await query(
    `SELECT c.*, u.email AS login_email, u.full_name AS login_name FROM conductors c
     LEFT JOIN users u ON u.id = c.user_id ORDER BY c.full_name`,
  );
  res.json({ data: rows });
});

router.post('/conductors', ...admin, validate({ body: conductorSchema }), async (req, res) => {
  const c = req.valid.body;
  await assertConductorLogin(c.userId);
  const row = await one(
    `INSERT INTO conductors (full_name, phone, cnic, user_id, is_active) VALUES ($1, $2, $3, $4, COALESCE($5, TRUE)) RETURNING *`,
    [c.fullName, c.phone, c.cnic ?? null, c.userId ?? null, c.isActive ?? null],
  ).catch(uniqueConductor);
  await audit({ req, action: 'conductor.create', entityType: 'conductor', entityId: row.id, newData: row });
  res.status(201).json({ data: row });
});

router.patch('/conductors/:id', ...admin, validate({ params: idParam, body: conductorSchema.partial() }), async (req, res) => {
  if (req.valid.body.userId) await assertConductorLogin(req.valid.body.userId);
  const before = await one(`SELECT * FROM conductors WHERE id = $1`, [req.valid.params.id]);
  if (!before) throw AppError.notFound('Conductor not found');
  const { setSql, values } = buildUpdate(req.valid.body, CONDUCTOR_COLS, 2);
  const row = await one(`UPDATE conductors SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]).catch(uniqueConductor);
  await audit({ req, action: 'conductor.update', entityType: 'conductor', entityId: row.id, oldData: before, newData: req.valid.body });
  res.json({ data: row });
});

// ======================= Staff directory (people who work but do not sign in) =======================
const JOBS = ['cleaner', 'loader', 'helper', 'guard', 'other'];
const staffMemberSchema = z
  .object({
    fullName: personName,
    phone: phone.optional(),
    cnic: cnic.optional(),
    job: z.enum(JOBS),
    terminalId: intId.nullable().optional(),
    notes: text(1, 300).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

const STAFF_MEMBER_COLS = {
  fullName: 'full_name', phone: 'phone', cnic: 'cnic', job: 'job', terminalId: 'terminal_id', notes: 'notes', isActive: 'is_active',
};

router.get('/staff-directory', ...staff, async (_req, res) => {
  const { rows } = await query(
    `SELECT s.*, c.name || ' · ' || t.name AS terminal_name FROM staff_directory s
     LEFT JOIN terminals t ON t.id = s.terminal_id LEFT JOIN cities c ON c.id = t.city_id
     ORDER BY s.is_active DESC, s.full_name`,
  );
  res.json({ data: rows });
});

router.post('/staff-directory', ...admin, validate({ body: staffMemberSchema }), async (req, res) => {
  const s = req.valid.body;
  const row = await one(
    `INSERT INTO staff_directory (full_name, phone, cnic, job, terminal_id, notes, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE)) RETURNING *`,
    [s.fullName, s.phone ?? null, s.cnic ?? null, s.job, s.terminalId ?? null, s.notes ?? null, s.isActive ?? null],
  );
  await audit({ req, action: 'staff_member.create', entityType: 'staff_member', entityId: row.id, newData: row });
  res.status(201).json({ data: row });
});

router.patch('/staff-directory/:id', ...admin, validate({ params: idParam, body: staffMemberSchema.partial() }), async (req, res) => {
  const { setSql, values } = buildUpdate(req.valid.body, STAFF_MEMBER_COLS, 2);
  const row = await one(`UPDATE staff_directory SET ${setSql} WHERE id = $1 RETURNING *`, [req.valid.params.id, ...values]);
  if (!row) throw AppError.notFound('Not found');
  await audit({ req, action: 'staff_member.update', entityType: 'staff_member', entityId: row.id, newData: req.valid.body });
  res.json({ data: row });
});

export default router;
