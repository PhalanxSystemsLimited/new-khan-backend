import { Router } from 'express';
import { z } from 'zod';
import { query, one } from '../../config/db.js';
import { validate } from '../../middleware/validate.js';
import { requireAuth, requireRole, ADMIN_ROLES } from '../../middleware/auth.js';
import { AppError } from '../../utils/AppError.js';
import { audit } from '../../utils/audit.js';

/*
 * Website content edited from the admin panel. Each section replaces the matching block of text built into the
 * frontend (src/data/site.js, src/data/legal.js); a section with no row keeps the built-in text.
 * Values are plain JSON rendered by React as text (never as HTML).
 */

/** Section key -> the JSON shape it must have. */
export const CONTENT_SECTIONS = {
  company: 'object', // name, helpline, email, address, hours, social links
  terminals: 'array', // terminal cards on the Terminals page
  destinations: 'array', // towns from Lahore: distance, fares, timetable (info pages, not booking)
  multanLinks: 'array', // towns on the Multan route
  busTypes: 'array', // coach classes on Fleet page
  promises: 'array', // home page promises / About commitments
  heritage: 'array', // "Our journey"
  team: 'array', // team cards on About
  faq: 'array', // home page FAQ
  legal: 'object', // { updated: {en,ur}, docs: [...] } policy pages
  cargoNote: 'object', // closing line of Cargo / Charter intros
};

const keyParam = z.object({ key: z.enum(Object.keys(CONTENT_SECTIONS)) }).strict();

const MAX_DEPTH = 12;
const MAX_STRING = 20_000;
/** Rejects script URLs and absurd nesting/lengths anywhere in the value. Returns an error message or null. */
function checkValue(v, depth = 0) {
  if (depth > MAX_DEPTH) return 'Content is nested too deeply';
  if (typeof v === 'string') {
    if (v.length > MAX_STRING) return 'A text field is too long';
    if (/^\s*(javascript|data|vbscript):/i.test(v)) return 'Links must start with https://, http://, tel:, mailto: or /';
    return null;
  }
  if (Array.isArray(v)) {
    if (v.length > 500) return 'A list has too many items';
    for (const x of v) {
      const e = checkValue(x, depth + 1);
      if (e) return e;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return 'Invalid field name';
      const e = checkValue(x, depth + 1);
      if (e) return e;
    }
    return null;
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return null;
  return 'Unsupported value';
}

// ---------------- Public ----------------
export const publicContentRouter = Router();

/** Every edited section, as { key: value }. Cached briefly by browsers and proxies. */
publicContentRouter.get('/', async (_req, res) => {
  const { rows } = await query(`SELECT key, value FROM site_content`);
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ data: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
});

// ---------------- Admin ----------------
export const adminContentRouter = Router();
adminContentRouter.use(requireAuth, requireRole(...ADMIN_ROLES));

/** Edited sections with who changed them and when. */
adminContentRouter.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT sc.key, sc.value, sc.updated_at, u.full_name AS updated_by_name
     FROM site_content sc LEFT JOIN users u ON u.id = sc.updated_by`,
  );
  res.set('Cache-Control', 'no-store');
  res.json({ data: rows });
});

adminContentRouter.put(
  '/:key',
  validate({ params: keyParam, body: z.object({ value: z.unknown() }).strict() }),
  async (req, res) => {
    const { key } = req.valid.params;
    const { value } = req.valid.body;
    const shape = CONTENT_SECTIONS[key];
    const ok = shape === 'array' ? Array.isArray(value) : value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!ok) throw AppError.badRequest(`Section "${key}" must be ${shape === 'array' ? 'a list' : 'an object'}`);
    const problem = checkValue(value);
    if (problem) throw AppError.badRequest(problem);

    const old = await one(`SELECT value FROM site_content WHERE key = $1`, [key]);
    const row = await one(
      `INSERT INTO site_content (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING key, value, updated_at`,
      [key, JSON.stringify(value), req.user.id],
    );
    await audit({ req, action: 'content.update', entityType: 'site_content', entityId: key, oldData: old?.value ?? null, newData: value });
    res.json({ data: row });
  },
);

/** Back to the text built into the website. */
adminContentRouter.delete('/:key', validate({ params: keyParam }), async (req, res) => {
  const { key } = req.valid.params;
  const old = await one(`DELETE FROM site_content WHERE key = $1 RETURNING value`, [key]);
  if (old) await audit({ req, action: 'content.reset', entityType: 'site_content', entityId: key, oldData: old.value });
  res.json({ data: { key, reset: Boolean(old) } });
});
