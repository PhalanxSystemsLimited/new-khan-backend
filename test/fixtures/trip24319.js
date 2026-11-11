/**
 * Trip 24319 (LHR ⇄ DIK via MWL, 02–03/11/2026): the acceptance figures from the report template.
 * Diesel is a manual fuel entry (spec update A); off-route lines are the DIK-route defaults.
 * The paper shows on-route expenses and cargo only as trip totals; how they split across vouchers here is
 * illustrative, the totals match the template.
 */
export const trip = { otherIncome: 0, otherExpense: 300, distanceKm: 909 };

export const legs = [
  { id: 1, legNo: 1, title: 'Lahore to DIK via Mianwali' },
  { id: 2, legNo: 2, title: 'DIK to Lahore via Mianwali' },
];

const onroute = (pairs) => pairs.map(([name, amount]) => ({ name, amount }));

export const vouchers = [
  {
    id: 11, legId: 1, terminalName: 'Lahore', paxTerminal: 42, paxEnroute: 5, incTerminal: 89_300, incEnroute: 10_600,
    loadAmount: 0, cargoAmount: 7_300, online: [],
    onroute: onroute([['Adda', 5_000], ['Booking clerk', 150], ['Howkery', 100], ['Manager', 200], ['TMA', 2_700], ['Welfare', 740]]),
  },
  {
    id: 21, legId: 2, terminalName: 'Dera Ismail Khan', paxTerminal: 8, paxEnroute: 34, incTerminal: 18_300, incEnroute: 38_900,
    loadAmount: 0, cargoAmount: 0, online: [],
    onroute: onroute([['Adda', 5_470], ['TMA', 2_700], ['Welfare', 740]]),
  },
  {
    id: 22, legId: 2, terminalName: 'Mianwali', paxTerminal: 11, paxEnroute: 0, incTerminal: 14_800, incEnroute: 0,
    loadAmount: 0, cargoAmount: 0, online: [], onroute: [],
  },
  {
    id: 23, legId: 2, terminalName: 'Sargodha', paxTerminal: 13, paxEnroute: 0, incTerminal: 15_000, incEnroute: 0,
    loadAmount: 0, cargoAmount: 0, online: [], onroute: [],
  },
];

export const fuel = [{ station: 'LHR', litres: 259.77, rate: 397.658, amount: 103_300 }];

export const offroute = onroute([
  ['Air cleaning', 130], ['Cleaning / washing', 550], ['Daily conductor', 2_500], ['Daily driver', 3_650],
  ['Daily hostess', 500], ['E-tag / toll tax', 10_380], ['Extra hawkery', 500], ['Greasing', 130], ['Incentives', 3_000],
  ['Mechanic charges', 500], ['Police daily expense', 100], ['Tyre puncture etc.', 100],
]);
