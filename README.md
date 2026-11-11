# New Khan Bus Service — Backend API

REST API for the New Khan intercity bus booking system: trip search, seat maps, seat holds, bookings,
Safepay online payments, counter (cash) sales, cancellations/refunds, and admin operations.

| | |
|---|---|
| Runtime | Node.js **20.12+**, ES modules |
| Framework | Express 5 |
| Database | **Supabase Postgres**, accessed directly with `pg` (no ORM) |
| Auth | **Supabase Auth** (email + password, phone OTP), proxied through this API |
| Payments | **Safepay** hosted checkout (card, JazzCash, Easypaisa) |
| Validation / logging | Zod / Pino |
| Frontend | Separate app in [`../frontend`](../frontend/README.md) |

---

## Contents

1. [Folder layout](#1-folder-layout)
2. [First-time setup](#2-first-time-setup)
3. [Environment variables](#3-environment-variables)
4. [Running](#4-running)
5. [Deploying](#5-deploying)
6. [How the system works](#6-how-the-system-works)
7. [Safepay payments](#7-safepay-payments)
8. [Database](#8-database)
9. [API reference](#9-api-reference)
10. [Security](#10-security)
11. [Known limitations and to-dos](#11-known-limitations-and-to-dos)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Folder layout

```
backend/
├── src/
│   ├── server.js              Entry point: starts HTTP server + booking-expiry job, graceful shutdown
│   ├── app.js                 Express app: security headers, CORS, rate limits, route mounting
│   ├── config/
│   │   ├── env.js             Reads and validates every environment variable (server won't start if invalid)
│   │   ├── db.js              pg pool, query helpers (rows come back camelCased), withTransaction()
│   │   └── supabase.js        Supabase clients (auth calls only)
│   ├── middleware/            auth (requireAuth / requireRole), rate limits, Zod validation, error handler
│   ├── modules/               One folder per feature: *.routes.js (HTTP) and *.service.js (logic)
│   │   ├── auth/              signup, login, OTP, refresh, logout, password reset
│   │   ├── users/             own profile, user/role management
│   │   ├── locations/         cities, terminals
│   │   ├── routes/            routes and their stops
│   │   ├── fleet/             seat layouts, buses, drivers
│   │   ├── fares/             fare table (per stop pair)
│   │   ├── schedules/         timetables and trip generation
│   │   ├── trips/             search, seat map, manifest, trip status
│   │   ├── bookings/          create/hold, list, lookup, cancel, review, boarding
│   │   ├── payments/          payment intent, cash, webhooks, Safepay (safepay.js), gateway adapters (gateways.js)
│   │   ├── content/           website content edited in the admin panel (public GET /content, admin save/reset)
│   │   └── admin/             promo codes, cancellation policies, refunds, reports, audit log, admin lists
│   ├── jobs/expireBookings.js Every minute: checks Safepay for unrecorded payments, then expires unpaid holds
│   └── utils/                 AppError, audit logging, logger, shared Zod schemas, SQL helpers
├── db/
│   ├── schema.sql             FULL database schema (tables, enums, triggers, functions). Source of truth.
│   ├── migrations/            Changes applied to the live DB after it was created (see §8)
│   ├── seed-dev.sql           Test data: towns, terminals, coaches, routes, fares, 30 days of trips
│   └── seed-dev-remove.sql    Removes everything seed-dev.sql added
├── scripts/
│   ├── run-sql.js             Runs a .sql file against DATABASE_URL
│   └── check-syntax.js        Syntax-checks every file (npm run check)
├── certs/supabase-ca.crt      Supabase CA certificate (for verified TLS to the DB)
├── ecosystem.config.cjs       PM2 config for a VPS
├── .env.example               Template for .env
└── .env                       Real secrets. NEVER commit or share.
```

> `../schema.sql` (in the project root) is an **old, unused** draft written for Neon. The real schema is `backend/db/schema.sql`.

---

## 2. First-time setup

### 2.1 Database (Supabase)

1. Create a Supabase project.
2. Dashboard → **SQL Editor** → paste the whole of [`db/schema.sql`](db/schema.sql) → **Run**.
   This already includes every migration in `db/migrations/`, so a fresh database does not need them.
3. (Optional) Test data: `npm run seed:dev` (remove later with `npm run seed:dev:remove`).
4. Create your first account (through the website's Sign in, or `POST /api/v1/auth/signup`), then make it a super admin in the SQL editor:
   ```sql
   update public.users set role = 'super_admin' where email = 'you@example.com';
   ```
5. (Optional) Phone OTP login: Dashboard → Authentication → Providers → **Phone**, and configure an SMS provider (Twilio, MessageBird, Vonage).

> **Data is only reachable through this API.** The schema enables Row Level Security on every table with no policies, and revokes
> access from Supabase's `anon` / `authenticated` roles. The Supabase REST API (or anyone holding the anon key) cannot read or write data.

### 2.2 Install and configure

```bash
cd backend
npm install
cp .env.example .env      # then fill in the values, see §3
npm run dev               # http://localhost:4000 , check http://localhost:4000/health
```

---

## 3. Environment variables

All variables are validated at startup in [`src/config/env.js`](src/config/env.js). If one is missing or wrong, the server
refuses to start and prints the variable's **name** (never its value).

| Variable | Required | Default | What it is / where to get it |
|---|---|---|---|
| `NODE_ENV` | | `development` | `production` on the server. In production stack traces are hidden and localhost CORS is not auto-allowed. |
| `PORT` | | `4000` | Port the API listens on |
| `LOG_LEVEL` | | `info` | `fatal` … `trace`, or `silent` |
| `TRUST_PROXY` | | `1` | Number of reverse proxies in front (Nginx / Hostinger = 1). Needed for correct client IPs in rate limiting. |
| `CORS_ORIGINS` | | – | Comma-separated frontend URLs allowed to call the API, e.g. `https://newkhan.com,https://www.newkhan.com` |
| `SUPABASE_URL` | ✔ | – | Supabase → Project Settings → API |
| `SUPABASE_ANON_KEY` | ✔ | – | Same page |
| `SUPABASE_SERVICE_ROLE_KEY` | ✔ | – | Same page. **Server only**, never put in the frontend. |
| `DATABASE_URL` | ✔ | – | Supabase → **Connect** → **Session pooler** string (port 5432, IPv4). Don't use the direct `db.*` host (IPv6 only). |
| `DB_POOL_MAX` | | `10` | Max DB connections |
| `DB_SSL` | | `true` | TLS to the DB |
| `DB_SSL_CA_PATH` | | – | e.g. `certs/supabase-ca.crt`. When set, the DB certificate is fully verified (recommended). |
| `AUTH_REDIRECT_URL` | | – | Where Supabase sends users from password-reset / confirmation emails |
| `BOOKING_HOLD_MINUTES` | | `20` | How long reserved seats stay held waiting for payment (2–60) |
| `MAX_SEATS_PER_BOOKING` | | `6` | Seats per booking |
| `APP_URL` | with Safepay | – | Public **frontend** URL, e.g. `https://newkhan.com`. Customers are sent back here after paying. |
| `API_PUBLIC_URL` | with Safepay | – | Public URL of **this API** without `/api/v1`, e.g. `https://api.newkhan.com`. Safepay redirects to it. |
| `SAFEPAY_ENV` | | `sandbox` | `sandbox` (test money) or `production` (real money) |
| `SAFEPAY_API_KEY` | | – | Safepay dashboard → Developer → API. **Empty = online payments disabled.** |
| `SAFEPAY_SECRET_KEY` | with Safepay | – | Same page |
| `SAFEPAY_WEBHOOK_SECRET` | with Safepay | – | Safepay dashboard → Developer → Webhooks → shared secret |
| `SAFEPAY_METHODS` | | `card,jazzcash,easypaisa` | Payment methods sent to Safepay |
| `PAYMENT_WEBHOOK_SECRET` | | – | Only for the generic relay webhook (another gateway, §7.5). Min 32 chars. Leave empty if unused. |

> **Local vs. production URLs.** Locally `APP_URL=http://localhost:5173` and `API_PUBLIC_URL=http://localhost:4000` work for the
> browser redirect, but Safepay's **webhook cannot reach localhost**. Payments still get confirmed (see §7.3), just not instantly.
> In production both must be the real public `https://` addresses.

---

## 4. Running

```bash
npm run dev              # development, restarts on file changes
npm start                # production
npm run check            # syntax-check every source file (there is no automated test suite)
npm run seed:dev         # load test data
npm run seed:dev:remove  # remove test data
node scripts/run-sql.js <file.sql>   # run any SQL file against DATABASE_URL
```

Health check: `GET /health` → `{"status":"ok"}` (or `503 degraded` if the DB is unreachable).

---

## 5. Deploying

**Run exactly one instance.** Rate limits and the booking-expiry job live in the Node process. Two instances would
double the job and split the rate limits.

### Hostinger VPS (recommended)

```bash
npm ci --omit=dev
npm install -g pm2
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs new-khan-api          # view logs
pm2 restart new-khan-api       # after changing code or .env
```

Put Nginx in front with HTTPS (Let's Encrypt), proxying to `PORT`. Keep `TRUST_PROXY=1`.

### Hostinger Node.js Web App (hPanel)

Entry file `src/server.js`, Node 20+, and add every variable from `.env.example` in the panel.

### Vercel (for live testing; moving to Hostinger later needs no code change)

The same code runs on both. On Hostinger `src/server.js` starts the server and the minute job; on Vercel
`api/index.js` hands the same Express app to Vercel (`vercel.json` sends every path to it) and the minute job is
replaced by a scheduled call. Two Vercel projects from the same repository:

| Project | Root Directory | What it uses |
|---|---|---|
| Website + admin panel | `frontend` | `frontend/vercel.json` (all pages open the app) |
| API | `backend` | `backend/vercel.json`, `backend/api/index.js` |

**API project, environment variables** (Settings → Environment Variables): everything from `.env`, with these
differences:

- `DATABASE_URL`: the Supabase **transaction pooler** URL (port **6543**) is best for serverless; the session
  pooler (5432) also works. `DB_POOL_MAX=3` (many small instances instead of one big one).
- `DB_SSL_CA`: paste the contents of `certs/supabase-ca.crt` (instead of `DB_SSL_CA_PATH`, a path on your PC).
  `DB_SSL_CA_PATH=certs/supabase-ca.crt` also works, since `vercel.json` ships the `certs` folder.
- `CRON_SECRET`: any long random text. `NODEJS_HELPERS=0` (Vercel then passes requests to Express untouched, like
  a normal server: needed for the payment webhook signature).
- `CORS_ORIGINS`, `APP_URL`: the website project's address, e.g. `https://new-khan.vercel.app`.
  `API_PUBLIC_URL`: this project's address (Safepay return links).

**Website project, environment variables:** `VITE_API_MODE=live`, `VITE_API_URL=https://<api-project>.vercel.app/api/v1`.
Supabase → Authentication → URL Configuration: add the website address (site URL and redirect URLs).

**Releasing unpaid seat holds on Vercel.** There is no process running between requests, so:
1. Trip search and seat maps release expired holds as they load (at most every 30 s per instance), so customers
   and counter staff always see freed seats.
2. Vercel Cron calls `GET /api/v1/internal/expire-bookings` (with `CRON_SECRET`). On the Hobby plan Vercel allows
   only one run a day (`vercel.json` is set to that); on Pro change the schedule to `* * * * *`. For every minute
   on any plan, either have a free scheduler (e.g. cron-job.org) call that URL with the header
   `Authorization: Bearer <CRON_SECRET>`, or let the database do it: enable **pg_cron** (Supabase → Database →
   Extensions) and run once
   `select cron.schedule('expire-bookings', '* * * * *', 'select public.expire_stale_bookings()');`

**Moving to Hostinger later:** delete the two Vercel projects; deploy `backend` as above (PM2, entry
`src/server.js`) with your normal `.env` (`DB_SSL_CA_PATH`, session pooler, `DB_POOL_MAX=10`, no `CRON_SECRET`);
build `frontend` with `npm run build` and serve `frontend/dist` with every page falling back to `index.html`
(Nginx: `try_files $uri /index.html;`). The files `vercel.json` and `api/index.js` are simply unused there.
If pg_cron was enabled it can stay: running the release twice is harmless.

### Production checklist

- [ ] `NODE_ENV=production`, real `CORS_ORIGINS`, `APP_URL`, `API_PUBLIC_URL` (https)
- [ ] `DB_SSL_CA_PATH=certs/supabase-ca.crt`
- [ ] Safepay: production keys, `SAFEPAY_ENV=production`, webhook registered (§7.4)
- [ ] One instance only
- [ ] Frontend built with `VITE_API_MODE=live` and `VITE_API_URL=https://<api>/api/v1`

---

## 6. How the system works

### 6.1 Data model in one paragraph

**Cities** have **terminals**. A **route** is an ordered list of **route stops** (each a terminal, with minutes from origin).
**Fares** are set per (route, boarding stop, dropping stop). A **seat layout** (e.g. 2+2, 40 seats) belongs
to **buses**. **Schedules** (route + departure time + days) generate dated **trips** (`POST /schedules/:id/generate-trips`).
A customer's **booking** is for one trip between two stops and has one **ticket** per seat/passenger. **Payments** and
**refunds** hang off the booking. A return journey is **two bookings** (one per bus).

### 6.2 Booking lifecycle

```
            pay (Safepay / cash)
 pending ─────────────────────────► confirmed ──► completed (trip done)
 (seats held)                           │
    │  hold runs out, unpaid            └── cancel ──► cancelled  (refund per cancellation policy)
    ▼
 expired (seats released) ── paid late & seats still free ──► confirmed
```

| Status | Meaning | Shown on website as |
|---|---|---|
| `pending` | Seats held for `BOOKING_HOLD_MINUTES` waiting for payment | Countdown tag + **Pay now** |
| `confirmed` | Paid, tickets issued | Confirmed |
| `expired` | Not paid in time, seats released | Hidden from My bookings; customer gets a one-time pop-up |
| `cancelled` / `refunded` | Cancelled by customer/staff | Cancelled |
| `completed` | Trip finished (needed before a review) | Confirmed |

Rules:
- A customer may have at most **3 unpaid (`pending`) bookings** at a time.
- **No double booking**: a unique index on `(trip_id, seat_id)` for active tickets. Two people can never hold the same seat.
- No seat is reserved for women. A male and a female passenger from **different bookings** may not sit side by side
  (neighbouring seats on the same side of the aisle, e.g. 1A–1B; across the aisle is fine). A mixed pair in one booking is
  allowed. Enforced by the `tickets_validate_seat_neighbours` trigger (error `SEAT_GENDER`, 409). Passengers are male or female only.
- **Refunds.** The amount always comes from the cancellation rules. Every booking stores its holder's CNIC (`holder_cnic`).
  - *Online* (customer cancels online, or the booking was paid online): refund is `requested`; only a **super admin** may
    approve/reject/mark it paid (`PATCH /admin/refunds/:id`), after sending the money back through Safepay.
  - *Counter* (`POST /bookings/:id/counter-cancel`, any staff role): staff confirm the holder, by CNIC match or, for bookings
    without a CNIC, a 6-digit SMS code (`POST /bookings/:id/counter-code`). Paid in cash → refunded in cash at once
    (`channel = 'counter'`, `processed`). Paid online → cancelled, refund goes to the super admin as above.
  - `GET /admin/reports/cash`: cash taken and refunded per staff member per day.
  - **SMS is not connected yet** (`src/utils/sms.js`): in development the code is shown on the staff screen; in production
    sending a code fails until a provider is added there.
- Seat holds/releases are done by DB triggers when the booking status changes (`release_seats_on_booking_end`).

### 6.3 Expiry of unpaid holds

Run by [`src/jobs/expireBookings.js`](src/jobs/expireBookings.js) every minute, plus at the start of every new booking:

1. For overdue `pending` bookings that have an open Safepay payment, the server **asks Safepay** whether it was paid, and confirms it if so.
2. Then the DB function `expire_stale_bookings()` marks overdue `pending` bookings `expired`, **except** bookings with an
   open Safepay checkout, which get up to **20 extra minutes** (so a customer paying right at the deadline isn't lost).
3. If a payment still arrives after expiry, `confirmBookingInTx()` **re-takes the same seats** if they are still free and the
   bus hasn't left, and confirms the booking. Only if a seat was taken by someone else is the payment refunded (a `refunds` row
   with status `approved` is created for staff to pay back).

### 6.4 "Reservation expired" notice

`GET /bookings/me` returns `expiry_seen_at` and `payment_received` per booking. The website shows a pop-up once for each unpaid
expired reservation (last 7 days) and then calls `POST /bookings/expiry-seen`, which records it **on the account**
(`bookings.expiry_seen_at`), so it isn't shown again on any device.

### 6.5 Roles

| Role | Can |
|---|---|
| `customer` | Book online, see/cancel own bookings |
| `agent` (**Counter staff**) | Tied to one terminal (`users.terminal_id`). Counter sales (cash), bookings, manifests, boarding, vouchers; generates the terminal voucher of **their own terminal** only |
| `conductor` | Only the conductor screen of trips they are the conductor (or stand-in) of: live seats and passengers, road passengers, no-shows |
| `manager` | Everything counter staff can, at any terminal + trip status, bus and crew, replacement vouchers, reading refunds and reports |
| `admin` | Everything + routes, fares, fleet, conductors, schedules, settings, deductions, promo codes, users (counter staff and conductors) |
| `super_admin` | Everything + giving manager and admin roles |

Roles are stored in `public.users.role` (never trusted from the token). Staff work in the **admin panel** of the website
(`/admin`), which calls the endpoints below. To make someone staff: they sign up on the website, then an admin changes their role
under *Users & staff* (counter staff also need a terminal). A conductor's login is then linked on *Fleet & people → Conductors*.
The very first super admin is set in SQL (§2.1 step 4). People who work but do not sign in (cleaners, loaders…) are listed in the
*Staff directory*.

**Terminal vouchers** (`src/modules/tripvouchers/`, migration `2026-11-10-terminal-vouchers-conductors.sql`): at each terminal the
counter staff press *Generate voucher*. It gets a 10-digit number from the same series as the report vouchers, is frozen, lists the
paid passengers boarding there by destination, how many are on the bus after the terminal, terminal cash (paid in cash at the
counter), online paid, load, cargo and the terminal's fixed deductions (*Terminal deductions*), and the cash handed to the conductor.
Generating it closes booking from that terminal (search and counter). A trip cannot board, depart or generate vouchers without a
conductor. A replacement voucher (bus swap) needs a manager or admin and a reason; cancelling a trip voids its vouchers. The conductor
opens the trip by voucher number at `/admin/conductor` and books road passengers (channel `on_road`, fare typed in or free), which
blocks those seats for every later terminal.

### 6.6 Website content

Text visitors read (contact details, terminals page, destinations with fares and times, FAQ, About items, policies) is built into
the frontend, and admins can override any section from the admin panel. Overrides are stored one row per section in
`site_content` (`key`, `value` JSON). `GET /content` returns them (public, cached 60 s); the website applies them at start-up.
A section without a row shows the built-in text. Sections: `company`, `terminals`, `destinations`, `multanLinks`, `busTypes`,
`promises`, `faq`, `heritage`, `team`, `cargoNote`, `legal`. Saves are checked (shape, size, no `javascript:` links) and logged
in the audit log.

### 6.7 Round Trip Reports

The income and expense sheet for one bus round trip (admin and super admin only; screens under **Admin → Round trip reports**).
Code: `src/modules/roundtrips/` (`report.calc.js` holds every formula; `roundtrips.service.js` the data rules). Tables come from
`db/migrations/2026-11-07-round-trip-reports.sql`.

- **Structure:** a round trip has legs; each leg has one **terminal voucher** per terminal (one row of the sales table: passengers,
  income, load/cargo, its own on-route expenses and online sales per platform).
- **Voucher numbers:** 10 digits, made by the database (`next_voucher_no()` locks a counter row per insert, plus a unique
  constraint), so parallel requests never get the same number and there are no gaps. A deleted voucher's number is not reused.
- **Diesel:** fuel entries typed in by an admin (station, litres, rate, amount). A blank amount is saved as round(litres × rate).
- **Off-route expenses:** categories and default amounts in *Off-route expenses* (global default, optional per-route amount or
  "off on this route", optional bus-class / hostess-bus limits). They are **copied** onto a report when it is created; later
  changes to the defaults never touch existing reports. Drafts can "Apply new defaults" (lines changed by hand are kept unless
  ticked). Per-report amount changes are admin-only and marked.
- **Finalize:** a finalized report cannot be changed (the API answers 409 `FINALIZED`).
- **QR codes:** every voucher (and the report header) has a 128-bit random token; the QR opens `APP_URL/r/<token>`, which loads
  `GET /reports/r/:token` fresh on every visit (`Cache-Control: no-store`) and highlights the scanned voucher. Staff must sign in
  unless `PUBLIC_TRIP_REPORT=true`. "New QR" revokes the old token (it then returns 404). Scans are logged (`report_scans`).
- **Printing:** the report page's *Download PDF* uses the browser's print dialog (choose "Save as PDF"); voucher slips print at
  80 mm or 58 mm from *Slip*.
- **Formulas:** A = Σ total sale; B = other income; X = Σ load + cargo; C = A + B + X; D = diesel + on route + off route;
  E = other expense; F = D + E; profit = (A−D) | (B−E) | (C−F); G = Σ online sales; cash deposit = C − F − G.

---

## 7. Safepay payments

Code: [`src/modules/payments/safepay.js`](src/modules/payments/safepay.js) and [`payments.routes.js`](src/modules/payments/payments.routes.js).

### 7.1 Flow

1. Website calls `POST /payments/intent` (`Idempotency-Key` header required). The server creates a `payments` row, creates a
   Safepay session for the booking total **read from the DB**, stores Safepay's tracker (`track_…`) in `payments.gateway_txn_id`,
   and returns a `redirectUrl` to Safepay's hosted checkout.
2. Customer pays on Safepay.
3. Safepay redirects the browser to `GET|POST /api/v1/payments/safepay/return/<lang>?tracker=…`.
4. The server **does not trust the URL**. It asks Safepay's API for that tracker; only if the state is `TRACKER_ENDED` (paid) for
   exactly the booking amount is the booking confirmed. The customer is then redirected to
   `APP_URL/<lang>/book/confirmed?ref=<bookingId>`.

### 7.2 Webhook

Safepay also calls `POST /api/v1/payments/webhook/safepay` (signature header `X-SFPY-SIGNATURE`, HMAC-SHA512 with
`SAFEPAY_WEBHOOK_SECRET`). Whichever of webhook / redirect arrives first confirms the booking; the second is ignored (idempotent).

### 7.3 Safety net (reconcile)

If neither the redirect nor the webhook arrives (customer closed the tab, webhook can't reach the server), the server still asks
Safepay about open payments: when the booking is opened, when *My bookings* / phone lookup is loaded, and every minute in the expiry job.

### 7.4 Setup

1. Sandbox account at sandbox.getsafepay.com → **Developer → API**: copy API key + secret key.
2. **Developer → Webhooks**: add `https://<API_PUBLIC_URL>/api/v1/payments/webhook/safepay`, subscribe to payment events,
   copy the shared secret into `SAFEPAY_WEBHOOK_SECRET`.
3. Set `SAFEPAY_ENV=sandbox`, `APP_URL`, `API_PUBLIC_URL`. For webhooks during local testing, expose the API with a tunnel
   (`cloudflared` / `ngrok`) and use that as `API_PUBLIC_URL`.
4. **Sandbox test cards**: use only the dummy cards from Safepay's help centre. Other cards fail at checkout with
   *"error performing action 'PAYER_AUTH_ENROLLMENT'"*. That is Safepay's 3-D Secure check rejecting the card, not a bug here.
5. Going live: finish Safepay merchant onboarding, switch to production keys, `SAFEPAY_ENV=production`, register the production webhook.

### 7.5 Another gateway

Add a provider in [`src/modules/payments/gateways.js`](src/modules/payments/gateways.js) implementing
`createCheckout(payment, { lang })` → `{ redirectUrl }` or `{ formUrl, fields }`, and `parseWebhook(req)` → `{ valid, ignore?, event? }`.
Methods without a real provider use the generic relay webhook: body `{ paymentId, status, amount, gatewayTxnId }`, headers
`x-timestamp` + `x-signature` = HMAC-SHA256(`PAYMENT_WEBHOOK_SECRET`, `"<timestamp>.<rawBody>"`).

### 7.6 Cash at the counter

Staff call `POST /payments/cash` with the booking id and exact amount; the booking is confirmed immediately.

---

## 8. Database

- **Source of truth:** [`db/schema.sql`](db/schema.sql). Always update it when you change the DB.
- **Migrations:** changes made to the existing live DB after it was first created are saved in `db/migrations/` as dated files.
  They have **already been applied** to the current Supabase project. Apply new ones with
  `node scripts/run-sql.js db/migrations/<file>.sql` (or paste into the Supabase SQL editor). All are written to be safe to re-run.

| Migration | What it does |
|---|---|
| `2026-11-05-safepay-expiry-grace.sql` | `expire_stale_bookings()` gives bookings with an open Safepay checkout up to 20 extra minutes |
| `2026-11-05-expiry-notice-seen.sql` | Adds `bookings.expiry_seen_at` (per-account "reservation expired" pop-up) |
| `2026-11-06-site-content.sql` | Adds the `site_content` table (website text edited in the admin panel) |

- Main tables: `users`, `cities`, `terminals`, `routes`, `route_stops`, `seat_layouts`, `layout_seats`, `buses`, `drivers`,
  `fares`, `schedules`, `trips`, `promo_codes`, `bookings`, `tickets`, `payments`, `refunds`, `cancellation_policies`,
  `reviews`, `notifications`, `audit_logs`, `site_content`.
- `public.users` is linked 1:1 to Supabase `auth.users` and filled by a trigger on signup.
- PNRs look like `NK4F7Q2M` (`generate_pnr()`); ticket numbers like `NK-YYYYMMDD-000001`.
- Optional: instead of the in-process job you can schedule the expiry in Supabase with pg_cron
  (`select cron.schedule('expire-bookings', '* * * * *', 'select public.expire_stale_bookings()')`) and set `DISABLE_JOBS=true`.
  But then the Safepay check before expiry (§6.3 step 1) no longer runs, so keep the in-process job unless you scale out.

---

## 9. API reference

Base path **`/api/v1`**. Auth = `Authorization: Bearer <accessToken>`.
Access: **public**, **C** = any signed-in user, **owner** = the booking's customer, **S** = staff (agent/admin/super_admin), **A** = admin.

| Method | Path | Access | Purpose |
|---|---|---|---|
| POST | `/auth/signup` | public | Email + password signup |
| POST | `/auth/login` | public | Email + password login → tokens |
| POST | `/auth/otp/send` · `/auth/otp/verify` | public | Phone OTP login |
| POST | `/auth/refresh` | public | New access token from refresh token |
| POST | `/auth/logout` | C | Revoke the session |
| POST | `/auth/password/forgot` · `/auth/password/reset` | public · C | Password reset |
| GET/PATCH | `/users/me` | C | Own profile |
| GET · PATCH | `/users` · `/users/:id/role` · `/users/:id/status` | A | User management |
| GET | `/cities` · `/terminals?cityId=` | public | Locations |
| POST/PATCH | `/cities[/:id]` · `/terminals[/:id]` | A | Manage locations |
| GET | `/routes` · `/routes/:id` | public | Routes and stops |
| POST/PATCH/PUT | `/routes` · `/routes/:id` · `/routes/:id/stops` | A | Manage routes |
| GET/POST/PATCH | `/fleet/layouts` · `/fleet/buses` · `/fleet/drivers` | S read · A write | Fleet |
| GET | `/fares?routeId=` | public | Fare table |
| POST/PATCH | `/fares[/:id]` | A | Manage fares |
| GET/POST/PATCH | `/schedules[/:id]` | S read · A write | Timetables |
| POST | `/schedules/:id/generate-trips` | A | Create dated trips (≤ 92 days, safe to re-run) |
| GET | `/trips/search?fromCityId&toCityId&date&passengers&busClass` | public | Search trips |
| GET | `/trips/:id` · `/trips/:id/seats` | public | Trip details, seat map (no passenger data) |
| GET | `/trips?date=` · `/trips/:id/manifest` | S | Operations |
| POST · PATCH | `/trips` · `/trips/:id/assignment` | A | Ad-hoc trips, bus/crew assignment |
| PATCH | `/trips/:id/status` | S (cancel = A) | boarding / departed / arrived / delayed / cancelled |
| POST | `/bookings` | C, S | Hold seats → `pending` booking |
| GET | `/bookings/me` | C | Own bookings (incl. `holdExpiresAt`, `expirySeenAt`, `paymentReceived`) |
| POST | `/bookings/expiry-seen` | C | `{ ids: [...] }` mark "reservation expired" notice as seen |
| GET | `/bookings/lookup?pnr&phone` | public | One booking by PNR + phone (reduced view) |
| GET | `/bookings/lookup-phone?phone` | public | All bookings for a mobile number (no passenger details) |
| GET | `/bookings` | S | Search bookings |
| GET | `/bookings/:id` · `/bookings/:id/cancel-quote` | owner, S | Details, refund preview |
| POST | `/bookings/:id/cancel` · `/bookings/:id/review` | owner, S | Cancel / review a completed trip |
| POST | `/tickets/:id/board` | S | Mark passenger boarded |
| POST | `/payments/intent` (+ `Idempotency-Key`) | owner | Start an online payment |
| POST | `/payments/cash` | S | Cash payment at the counter |
| POST | `/payments/webhook/:gateway` | signed | Gateway callback (`safepay`) |
| GET/POST | `/payments/safepay/return[/:lang]` | – | Safepay browser redirect (verified with Safepay's API) |
| GET/POST/PATCH | `/admin/promo-codes` | A | Promo codes |
| GET/PUT | `/admin/cancellation-policies` | A | Refund rules (hours before departure → % refunded) |
| GET/PATCH | `/admin/refunds[/:id]` | A | Process refunds |
| GET | `/admin/reports/daily-revenue` · `/admin/reports/summary` · `/admin/audit-logs` | A | Reporting |
| GET | `/admin/routes` · `/admin/routes/:id` · `/admin/locations` | A | Lists for the admin panel, including inactive routes, cities, terminals |
| GET | `/content` | public | Website content saved in the admin panel (`{ key: value }`) |
| GET · PUT · DELETE | `/admin/content` · `/admin/content/:key` | A | List / save (`{ value }`, up to 1 MB) / reset a content section |
| GET | `/health` (no `/api/v1`) | public | Liveness + DB check |

**Error format** (every error):
```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": [{ "field": "date", "message": "Invalid date" }], "requestId": "…" } }
```
Quote the `requestId` (also in the `X-Request-Id` response header) when searching the logs.

---

## 10. Security

- **Validation:** every body, query and path param is checked with Zod; unknown fields are rejected, so clients can't send `role`, prices, etc.
- **Prices are server-side:** fares, discounts and payment amounts always come from the DB.
- **Auth:** tokens are verified with Supabase on every request; roles come from the DB.
- **Rate limits** (per IP, or per user when signed in): global 300 / 15 min (heavy admin use from one office IP can reach it; raise `limit` in `rateLimit.js` if staff see "Too many requests"); login 10 / 15 min; OTP 5 / hour;
  booking 20 / hour; PNR/phone lookup 20 / 15 min; payment 30 / 15 min; search 60 / min.
- **Payments:** idempotency keys, signed webhooks with constant-time comparison, amounts checked against the booking,
  return URLs verified with Safepay's API, duplicate/late payments refunded.
- **Hardening:** Helmet, CORS allowlist, 50 kb JSON limit, JSON-only bodies, parameterised SQL only, secrets removed from logs,
  no stack traces in production, request IDs, server timeouts.
- **Audit log** of admin actions (`audit_logs`).
- **Privacy:** customers only see their own bookings; seat maps and public lookups hide passenger details/CNICs.

---

## 11. Known limitations and to-dos

| Item | Status |
|---|---|
| **SMS / email confirmations** | Confirmations are **queued** in the `notifications` table, but **nothing sends them yet**. A sender (e.g. an SMS provider) needs to be built. |
| **Refund payouts** | Refunds are **recorded** (`refunds`, status `approved`). Money is **not** sent back automatically; staff refund via Safepay's dashboard, then mark the refund `processed` with `PATCH /admin/refunds/:id`. |
| **Admin panel gaps** | The `/admin` panel covers daily operations, setup, people, reports and website content. Not in it yet: creating new seat layouts (API only), uploading images (use a path or link), editing a booking's passengers. |
| **Info pages vs booking prices** | Fares/times on the information pages are *website content*; booking prices are the *Fares* table. Admins must keep both in line. |
| **Automated tests** | None; `npm run check` only checks syntax. |
| **Scaling** | Single instance only (in-memory rate limits + job). Scaling out needs a Redis store for rate limits and moving the job. |
| **Version control** | The project folder is not a git repository. Put it in one, and keep `.env` out of it. |

---

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Server exits with "Invalid environment configuration" | A variable in `.env` is missing or invalid; the message names it. |
| `CORS_NOT_ALLOWED` in the browser | Add the frontend URL to `CORS_ORIGINS` (localhost is auto-allowed only when `NODE_ENV` isn't `production`). |
| DB connection errors / timeouts | Use the **Session pooler** URL (IPv4), not the direct host. Check the password and `DB_SSL_CA_PATH`. |
| Paid booking shows "Held" for a minute | Webhook couldn't reach the server (e.g. localhost). The reconcile step confirms it on next load / within a minute. |
| Safepay "PAYER_AUTH_ENROLLMENT failed" | Not a Safepay sandbox test card; see §7.4. |
| `TOO_MANY_PENDING` | Customer has 3 unpaid bookings; pay or cancel one. |
| `DB_MIGRATION_MISSING` (503) | The code is newer than the database: run the newest files in `db/migrations/` (the log shows the missing table or column). |
| Changes not taking effect | Restart the process (`pm2 restart new-khan-api`). `.env` is only read at startup. |
