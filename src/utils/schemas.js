import { z } from 'zod';

// Reusable, strict building blocks for request validation.

export const uuid = z.string().uuid();
export const intId = z.coerce.number().int().positive().max(2_147_483_647);
export const bigId = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const idParam = z.object({ id: intId }).strict();
export const uuidParam = z.object({ id: uuid }).strict();
export const bigIdParam = z.object({ id: bigId }).strict();

const noControlChars = (s) => !/[\u0000-\u001F\u007F]/.test(s);

/** Trimmed single-line text without control characters. */
export const text = (min = 1, max = 255) =>
  z.string().trim().min(min).max(max).refine(noControlChars, 'Contains invalid characters');

/** Multi-line free text (newlines allowed, other control chars not). */
export const longText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s), 'Contains invalid characters');

export const personName = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[\p{L}\p{M} .'-]+$/u, 'Name may only contain letters, spaces, dots, apostrophes and hyphens');

/** Pakistani or international phone in E.164-ish form. 03001234567 -> +923001234567 */
export const phone = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (/^03\d{9}$/.test(v) ? `+92${v.slice(1)}` : v))
  .refine((v) => /^\+[1-9]\d{9,14}$/.test(v), 'Invalid phone number (use +923001234567 or 03001234567)');

export const email = z.string().trim().toLowerCase().email().max(255);

export const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .refine(
    (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v) && /[!@#$%^&*()_+\-=[\]{};':"|<>?,./`~\\]/.test(v),
    'Password must contain an upper-case letter, a lower-case letter, a number and a special character (e.g. ! @ # $ %)',
  );

export const cnic = z
  .string()
  .trim()
  .regex(/^\d{5}-?\d{7}-?\d$/, 'CNIC must be like 35202-1234567-1')
  .transform((v) => v.replace(/-/g, '').replace(/^(\d{5})(\d{7})(\d)$/, '$1-$2-$3'));

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Invalid date');

export const isoDateTime = z.string().datetime({ offset: true });

export const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Time must be HH:MM');

export const money = z.coerce.number().nonnegative().max(10_000_000).multipleOf(0.01);

export const gender = z.enum(['male', 'female']);
export const busClass = z.enum(['economy', 'executive', 'business', 'sleeper']);

export const pagination = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const boolQuery = z.enum(['true', 'false']).transform((v) => v === 'true');
