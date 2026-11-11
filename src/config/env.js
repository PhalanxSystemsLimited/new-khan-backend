import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(1),
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// connection string'),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DB_SSL_CA_PATH: z.string().optional().default(''),
  DB_SSL: bool.default('true'),

  AUTH_REDIRECT_URL: z.string().url().optional(),

  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(2).max(60).default(20),
  // Online booking from a terminal closes this many minutes before the bus is due there (every terminal, delays
  // included). Counter staff keep selling until that terminal's voucher is generated.
  ONLINE_CUTOFF_MINUTES: z.coerce.number().int().min(0).max(720).default(60),
  MAX_SEATS_PER_BOOKING: z.coerce.number().int().min(1).max(20).default(6),

  // Only for the generic relay webhook (non-Safepay methods). Leave unset to disable that webhook.
  PAYMENT_WEBHOOK_SECRET: z
    .union([z.literal(''), z.string().min(32, 'PAYMENT_WEBHOOK_SECRET must be at least 32 characters')])
    .optional()
    .default(''),

  // Public URLs used to build payment return/cancel links.
  APP_URL: z.string().url().optional(), // the frontend, e.g. https://newkhan.com
  API_PUBLIC_URL: z.string().url().optional(), // this API as the internet sees it, e.g. https://api.newkhan.com

  // Round Trip Report page opened by a voucher QR: false = staff must sign in (default), true = anyone with the link.
  PUBLIC_TRIP_REPORT: bool.default('false'),

  // ---- Safepay (enabled when SAFEPAY_API_KEY is set) ----
  SAFEPAY_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  SAFEPAY_API_KEY: z.string().trim().optional().default(''),
  SAFEPAY_SECRET_KEY: z.string().trim().optional().default(''),
  SAFEPAY_WEBHOOK_SECRET: z.string().trim().optional().default(''),
  SAFEPAY_METHODS: z
    .string()
    .default('card,jazzcash,easypaisa')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(['card', 'jazzcash', 'easypaisa', 'bank_transfer', 'wallet']))),
}).superRefine((v, ctx) => {
  if (!v.SAFEPAY_API_KEY) return;
  for (const key of ['SAFEPAY_SECRET_KEY', 'SAFEPAY_WEBHOOK_SECRET', 'APP_URL', 'API_PUBLIC_URL']) {
    if (!v[key]) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'required when SAFEPAY_API_KEY is set' });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Print only variable names and messages, never values.
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = Object.freeze({
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
});
