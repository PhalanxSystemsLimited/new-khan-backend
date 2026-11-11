/**
 * Round Trip Report: database and HTTP tests. They WRITE data, so they only run against a separate test
 * database that has db/schema.sql (or the migrations) applied:
 *
 *   TEST_DATABASE_URL=postgresql://... npm test
 *
 * Without TEST_DATABASE_URL they are skipped. They refuse to run against the DATABASE_URL in .env.
 * Everything they create is removed at the end.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import dotenv from 'dotenv';

const TEST_DB = process.env.TEST_DATABASE_URL;
const mainDb = fs.existsSync('.env') ? dotenv.parse(fs.readFileSync('.env')).DATABASE_URL : undefined;
const skip = !TEST_DB
  ? 'set TEST_DATABASE_URL to a separate test database to run these'
  : TEST_DB === mainDb
    ? 'TEST_DATABASE_URL is the same as DATABASE_URL in .env: refusing to write test data there'
    : false;

let db, svc, server, base;
const made = { roundTrips: [], busId: null, categoryId: null };

before(async () => {
  if (skip) return;
  // Must be set before any app module reads the environment.
  process.env.DATABASE_URL = TEST_DB;
  process.env.PUBLIC_TRIP_REPORT = 'true'; // test the token → report path without a Supabase sign-in
  db = await import('../src/config/db.js');
  svc = await import('../src/modules/roundtrips/roundtrips.service.js');
  const { createApp } = await import('../src/app.js');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const layout = await db.one(`SELECT id FROM seat_layouts ORDER BY id LIMIT 1`);
  assert.ok(layout, 'the test database needs at least one seat layout');
  const bus = await db.one(
    `INSERT INTO buses (registration_no, layout_id, bus_class) VALUES ($1, $2, 'executive') RETURNING id`,
    [`TEST-${Date.now().toString(36)}`, layout.id],
  );
  made.busId = bus.id;
});

after(async () => {
  if (skip) return;
  server?.close();
  for (const id of made.roundTrips) await db.query(`DELETE FROM round_trips WHERE id = $1`, [id]);
  if (made.categoryId) await db.query(`DELETE FROM offroute_categories WHERE id = $1`, [made.categoryId]);
  if (made.busId) await db.query(`DELETE FROM buses WHERE id = $1`, [made.busId]);
  await db.pool.end();
});

async function newRoundTrip(extra = {}) {
  const { id } = await db.withTransaction((client) =>
    svc.createRoundTrip(client, {
      userId: null,
      input: {
        busId: made.busId, routeLabel: 'TEST ⇄ TEST', reportDate: '2026-11-03', distanceKm: 909,
        legs: [{ title: 'Out' }, { title: 'Back' }], ...extra,
      },
    }),
  );
  made.roundTrips.push(id);
  const legs = (await db.query(`SELECT id FROM round_trip_legs WHERE round_trip_id = $1 ORDER BY leg_no`, [id])).rows;
  return { id, legs };
}

const addVoucher = (roundTripId, legId, v = {}) =>
  db.withTransaction((client) =>
    svc.createVoucher(client, { roundTripId, userId: null, v: { legId, terminalName: 'Lahore', paxTerminal: 10, incTerminal: 20_000, ...v } }),
  );

const scan = async (token) => {
  const res = await fetch(`${base}/reports/r/${token}`);
  return { status: res.status, body: await res.json().catch(() => null) };
};

test('voucher numbers stay unique when created in parallel', { skip }, async () => {
  const { id, legs } = await newRoundTrip();
  const made50 = await Promise.all(Array.from({ length: 50 }, (_, i) => addVoucher(id, legs[i % 2].id)));
  const numbers = made50.map((v) => v.voucherNo);
  for (const n of numbers) assert.match(n, /^\d{10}$/);
  assert.equal(new Set(numbers).size, 50, 'every voucher number is different');
  const sorted = numbers.map(Number).sort((a, b) => a - b);
  assert.equal(sorted.at(-1) - sorted[0], 49, 'numbers are consecutive (no gaps from parallel requests)');
  // The database itself refuses a duplicate even if someone bypasses the generator.
  await assert.rejects(
    db.query(`UPDATE terminal_vouchers SET voucher_no = $2 WHERE id = $1`, [made50[0].id, made50[1].voucherNo]),
  );
});

test('a voucher token opens the report of its own trip, with that row marked', { skip }, async () => {
  const a = await newRoundTrip();
  const b = await newRoundTrip();
  const va = await addVoucher(a.id, a.legs[0].id, { terminalName: 'Lahore' });
  const vb = await addVoucher(b.id, b.legs[1].id, { terminalName: 'Sargodha' });

  const ra = await scan(va.token);
  assert.equal(ra.status, 200);
  assert.equal(ra.body.data.trip.id, a.id);
  assert.equal(ra.body.data.scannedVoucherId, va.id);
  assert.equal(ra.body.data.edit, undefined, 'the scan page never gets the admin-only fields');

  const rb = await scan(vb.token);
  assert.equal(rb.body.data.trip.id, b.id);
  assert.equal(rb.body.data.legs[1].rows[0].voucherNo, vb.voucherNo);

  const logged = await db.one(`SELECT count(*)::int AS n FROM report_scans WHERE voucher_id = $1`, [va.id]);
  assert.equal(logged.n, 1, 'the scan is logged');
});

test('an edited trip shows the new figures on the next scan', { skip }, async () => {
  const { id, legs } = await newRoundTrip();
  const v = await addVoucher(id, legs[0].id, { incTerminal: 20_000 });
  const first = await scan(v.token);
  assert.equal(first.body.data.summary.incomeSub, 20_000);

  await db.withTransaction(async (client) => {
    await svc.assertDraft(client, id);
    await svc.updateVoucher(client, { roundTripId: id, voucherId: v.id, v: { incTerminal: 25_500, online: [{ platformName: 'Bookme', seats: 1, amount: 1_500 }] } });
    await svc.touch(client, id);
  });
  const second = await scan(v.token);
  assert.equal(second.body.data.summary.incomeSub, 27_000);
  assert.equal(second.body.data.summary.lessOnline, 1_500);
  assert.ok(new Date(second.body.data.trip.updatedAt) >= new Date(first.body.data.trip.updatedAt));
});

test('a revoked token returns 404 and the new one works', { skip }, async () => {
  const { id, legs } = await newRoundTrip();
  const v = await addVoucher(id, legs[0].id);
  const fresh = await db.withTransaction((client) => svc.regenerateToken(client, { roundTripId: id, voucherId: v.id }));
  assert.notEqual(fresh.token, v.token);
  assert.equal((await scan(v.token)).status, 404);
  assert.equal((await scan(fresh.token)).status, 200);
  assert.equal((await scan('AAAAAAAAAAAAAAAAAAAAAA')).status, 404, 'an unknown token is 404 too');
});

test('changing a default never changes an existing trip (snapshot), and finalized trips are locked', { skip }, async () => {
  const cat = await db.one(
    `INSERT INTO offroute_categories (name, sort_order) VALUES ($1, 999) RETURNING id`,
    [`Test expense ${Date.now()}`],
  );
  made.categoryId = cat.id;
  await db.query(`INSERT INTO offroute_defaults (category_id, route_id, amount) VALUES ($1, NULL, 700)`, [cat.id]);

  const { id, legs } = await newRoundTrip();
  const line = await db.one(`SELECT id, amount FROM round_trip_offroute_lines WHERE round_trip_id = $1 AND category_id = $2`, [id, cat.id]);
  assert.equal(line.amount, 700, 'copied from the default when the trip was created');

  await db.query(`UPDATE offroute_defaults SET amount = 900 WHERE category_id = $1 AND route_id IS NULL`, [cat.id]);
  assert.equal((await db.one(`SELECT amount FROM round_trip_offroute_lines WHERE id = $1`, [line.id])).amount, 700);

  const preview = await svc.previewDefaults(undefined, id);
  assert.ok(preview.changes.some((c) => c.lineId === line.id && c.from === 700 && c.to === 900));

  await addVoucher(id, legs[0].id);
  await db.query(`UPDATE round_trips SET status = 'finalized', finalized_at = now() WHERE id = $1`, [id]);
  await assert.rejects(
    db.withTransaction((client) => svc.assertDraft(client, id)),
    (err) => err.code === 'FINALIZED',
  );
});
