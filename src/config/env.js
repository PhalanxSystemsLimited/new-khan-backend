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
  // The same certificate as text (PEM), for hosts without a file system you control (Vercel). Wins over the path.
  DB_SSL_CA: z.string().optional().default(''),
  DB_SSL: bool.default('true'),

  AUTH_REDIRECT_URL: z.string().url().optional(),

  BOOKING_HOLD_MINUTES: z.coerce.number().int().min(2).max(60).default(20),
  // Online booking from a terminal closes this many minutes before the bus is due there (every terminal, delays
  // included). Counter staff keep selling until that terminal's voucher is generated.
  ONLINE_CUTOFF_MINUTES: z.coerce.number().int().min(0).max(720).default(60),

  // Serverless hosts: protects GET /api/v1/internal/expire-bookings (Vercel Cron sends it as a Bearer token).
  // Leave empty on a long-running server: that endpoint is then off and the in-process minute job does the work.
  CRON_SECRET: z.union([z.literal(''), z.string().min(16, 'CRON_SECRET must be at least 16 characters')]).optional().default(''),
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

  // ---- SMS (off until SMS_API_URL is set) ----
  // Any Pakistani bulk-SMS provider (Jazz, Zong, Telenor or an aggregator) that sends by calling a web address.
  // SMS_API_URL is the provider's sending address with placeholders the server fills in:
  //   {to} {text} {sender} {username} {password}
  // e.g. https://sms.example.pk/api/send?user={username}&pass={password}&from={sender}&to={to}&msg={text}
  SMS_API_URL: z.union([z.literal(''), z.string().url()]).optional().default(''),
  SMS_METHOD: z.enum(['GET', 'POST']).default('GET'), // POST sends the address's "?..." part as a form body
  SMS_USERNAME: z.string().optional().default(''),
  SMS_PASSWORD: z.string().optional().default(''),
  SMS_SENDER: z.string().trim().max(20).optional().default(''), // the sender name, e.g. NEWKHAN
  // How the provider wants numbers: intl = 923001234567, local = 03001234567, plus = +923001234567.
  SMS_PHONE_FORMAT: z.enum(['intl', 'local', 'plus']).default('intl'),
  // Some providers answer "OK" even on failure: if set, the reply must contain this text to count as sent.
  SMS_SUCCESS_TEXT: z.string().optional().default(''),

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
