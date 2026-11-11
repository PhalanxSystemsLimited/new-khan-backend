/**
 * Round Trip Report figures. Pure functions (no database), so the report page, the PDF and the tests all use
 * the same arithmetic. Money is whole rupees; litres and rates keep their decimals.
 *
 *   row.total_sale   = terminal + en route + online income of that voucher
 *   A income_sub     = Σ row.total_sale
 *   B income_others  = other income
 *   X cargo_load     = Σ voucher load + cargo
 *   C income_net     = A + B + X
 *   D expense_sub    = diesel + on route + off route
 *   E expense_others = other expense
 *   F expense_net    = D + E
 *   profit           = (A − D) | (B − E) | (C − F)
 *   G less_online    = Σ online sales
 *   net cash = cash deposit = C − F − G
 */

const sum = (list, pick) => list.reduce((s, x) => s + (Number(pick(x)) || 0), 0);

/** Prefilled fuel amount: round(litres × rate), rounded half up on the 3-decimal inputs (no float drift). */
export function fuelAmount(litres, rate) {
  const l = Math.round(Number(litres) * 1000);
  const r = Math.round(Number(rate) * 1000);
  if (!Number.isFinite(l) || !Number.isFinite(r) || l < 0 || r < 0) return 0;
  // l and r are in thousandths, so l*r is in millionths. BigInt keeps it exact for any size.
  return Number((BigInt(l) * BigInt(r) + 500_000n) / 1_000_000n);
}

/** Groups lines by name (first appearance order), summing amount and seats. */
function groupByName(lines, nameOf) {
  const map = new Map();
  for (const l of lines) {
    const name = nameOf(l);
    const g = map.get(name) ?? { name, amount: 0, seats: 0 };
    g.amount += Number(l.amount) || 0;
    g.seats += Number(l.seats) || 0;
    map.set(name, g);
  }
  return [...map.values()];
}

/**
 * @param {object} t   round trip: { otherIncome, otherExpense, distanceKm }
 * @param {object} p   { legs: [{ id, title, legRef }], vouchers: [{ id, legId, ..., onroute: [], online: [] }],
 *                       fuel: [{ station, litres, rate, amount }], offroute: [{ name, amount }] }
 */
export function computeReport(t, { legs, vouchers, fuel, offroute }) {
  const rows = vouchers.map((v) => {
    const incOnline = sum(v.online ?? [], (o) => o.amount);
    return {
      ...v,
      incOnline,
      totalSale: (Number(v.incTerminal) || 0) + (Number(v.incEnroute) || 0) + incOnline,
    };
  });

  const legBlocks = legs.map((leg) => {
    const legRows = rows.filter((r) => r.legId === leg.id);
    return { ...leg, rows: legRows, passengers: sum(legRows, (r) => r.paxTerminal + r.paxEnroute) };
  });

  const A = sum(rows, (r) => r.totalSale);
  const B = Number(t.otherIncome) || 0;
  const X = sum(rows, (r) => (Number(r.loadAmount) || 0) + (Number(r.cargoAmount) || 0));
  const C = A + B + X;

  const diesel = sum(fuel, (f) => f.amount);
  const onrouteLines = groupByName(rows.flatMap((r) => r.onroute ?? []), (l) => l.name);
  const onroute = sum(onrouteLines, (l) => l.amount);
  const offrouteTotal = sum(offroute ?? [], (l) => l.amount);
  const D = diesel + onroute + offrouteTotal;
  const E = Number(t.otherExpense) || 0;
  const F = D + E;

  const online = groupByName(rows.flatMap((r) => r.online ?? []), (l) => l.platformName);
  const G = sum(online, (o) => o.amount);

  // Litres summed in thousandths so 259.77 stays 259.77.
  const litres = sum(fuel, (f) => Math.round(Number(f.litres) * 1000)) / 1000;
  const distance = Number(t.distanceKm) || 0;

  return {
    legs: legBlocks,
    onroute: onrouteLines.filter((l) => l.amount !== 0),
    online: online.filter((o) => o.amount !== 0 || o.seats !== 0),
    totals: {
      paxTerminal: sum(rows, (r) => r.paxTerminal),
      paxEnroute: sum(rows, (r) => r.paxEnroute),
      paxAll: sum(rows, (r) => r.paxTerminal + r.paxEnroute),
      incTerminal: sum(rows, (r) => r.incTerminal),
      incEnroute: sum(rows, (r) => r.incEnroute),
      incOnline: sum(rows, (r) => r.incOnline),
      totalSale: A,
      cargoLoad: X,
      dieselLitres: litres,
      avgKm: litres > 0 ? Math.round((distance / litres) * 100) / 100 : null,
    },
    expenses: { diesel, onroute, offroute: offrouteTotal, dieselOnroute: diesel + onroute },
    summary: {
      incomeSub: A,
      incomeOthers: B,
      incomeNet: C,
      expenseSub: D,
      expenseOthers: E,
      expenseNet: F,
      profitSub: A - D,
      profitOthers: B - E,
      profitNet: C - F,
      lessOnline: G,
      netCash: C - F - G,
      cashDeposit: C - F - G,
    },
  };
}
