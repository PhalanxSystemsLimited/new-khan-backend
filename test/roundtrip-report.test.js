// Round Trip Report arithmetic and tokens. No database needed: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeReport, fuelAmount } from '../src/modules/roundtrips/report.calc.js';
import { newToken, TOKEN_RE } from '../src/modules/roundtrips/token.js';
import * as t24319 from './fixtures/trip24319.js';

test('fuel amount is prefilled as round(litres × rate)', () => {
  assert.equal(fuelAmount(259.77, 397.658), 103_300); // 103,299.6
  assert.equal(fuelAmount(100, 300.004), 30_000); // 30,000.4 → 30,000
  assert.equal(fuelAmount(1, 0.5), 1); // half rounds up
  assert.equal(fuelAmount(0, 400), 0);
  assert.equal(fuelAmount(9_999_999.999, 9_999_999.999), 99_999_999_980_000); // no float overflow
});

test('Trip 24319 acceptance figures', () => {
  const r = computeReport(t24319.trip, t24319);

  // Sales by terminal
  assert.deepEqual(r.legs[0].rows.map((x) => x.totalSale), [99_900]);
  assert.deepEqual(r.legs[1].rows.map((x) => x.totalSale), [57_200, 14_800, 15_000]);
  assert.equal(r.legs[0].passengers, 47);
  assert.equal(r.legs[1].passengers, 66);
  assert.deepEqual(
    { ...r.totals, avgKm: r.totals.avgKm },
    {
      paxTerminal: 74, paxEnroute: 39, paxAll: 113, incTerminal: 137_400, incEnroute: 49_500, incOnline: 0,
      totalSale: 186_900, cargoLoad: 7_300, dieselLitres: 259.77, avgKm: 3.5,
    },
  );

  // Expenses
  assert.deepEqual(r.expenses, { diesel: 103_300, onroute: 17_800, offroute: 22_040, dieselOnroute: 121_100 });
  assert.deepEqual(
    r.onroute.map((l) => [l.name, l.amount]),
    [['Adda', 10_470], ['Booking clerk', 150], ['Howkery', 100], ['Manager', 200], ['TMA', 5_400], ['Welfare', 1_480]],
  );

  // Settlement
  assert.deepEqual(r.summary, {
    incomeSub: 186_900, incomeOthers: 0, incomeNet: 194_200,
    expenseSub: 143_140, expenseOthers: 300, expenseNet: 143_440,
    profitSub: 43_760, profitOthers: -300, profitNet: 50_760,
    lessOnline: 0, netCash: 50_760, cashDeposit: 50_760,
  });
});

test('online sales count in total sale and are subtracted before cash deposit', () => {
  const vouchers = t24319.vouchers.map((v) =>
    v.id === 21 ? { ...v, online: [{ platformName: 'Bookme', seats: 2, amount: 4_000 }, { platformName: 'Web app', seats: 1, amount: 2_000 }] } : v,
  );
  const r = computeReport(t24319.trip, { ...t24319, vouchers });
  assert.equal(r.legs[1].rows[0].incOnline, 6_000);
  assert.equal(r.summary.incomeSub, 192_900);
  assert.equal(r.summary.lessOnline, 6_000);
  assert.equal(r.summary.netCash, 50_760); // same cash: the platforms hold the online money
  assert.deepEqual(r.online.map((o) => [o.name, o.seats, o.amount]), [['Bookme', 2, 4_000], ['Web app', 1, 2_000]]);
});

test('zero lines are left out and no diesel gives no average', () => {
  const r = computeReport({ otherIncome: 0, otherExpense: 0, distanceKm: 500 }, {
    legs: [{ id: 1, title: 'A to B' }],
    vouchers: [{ id: 1, legId: 1, paxTerminal: 0, paxEnroute: 0, incTerminal: 0, incEnroute: 0, onroute: [{ name: 'Adda', amount: 0 }], online: [] }],
    fuel: [],
    offroute: [],
  });
  assert.deepEqual(r.onroute, []);
  assert.equal(r.totals.avgKm, null);
  assert.equal(r.summary.netCash, 0);
});

test('report tokens are 128-bit, URL-safe and unique', () => {
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const tok = newToken();
    assert.match(tok, TOKEN_RE);
    assert.equal(tok.length, 22);
    seen.add(tok);
  }
  assert.equal(seen.size, 5000);
});
