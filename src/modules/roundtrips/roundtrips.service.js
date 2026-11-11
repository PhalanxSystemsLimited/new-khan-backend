/**
 * Round Trip Reports: data access and rules.
 *  - A finalized round trip can never be changed (assertDraft locks the row and checks).
 *  - Off-route lines are copied from the defaults when the trip is created (snapshot); changing a default later
 *    never touches an existing trip. "Apply new defaults" exists for drafts only.
 *  - Voucher numbers come from the database (next_voucher_no, unique constraint); QR tokens are 128-bit random.
 */
import QRCode from 'qrcode';
import { query, one } from '../../config/db.js';
import { env } from '../../config/env.js';
import { AppError } from '../../utils/AppError.js';
import { computeReport } from './report.calc.js';
import { newToken, TOKEN_RE } from './token.js';

export { newToken };

// ---------------------------------------------------------------------------------------------------------------
// Tokens and QR codes
// ---------------------------------------------------------------------------------------------------------------
export const reportUrl = (token) => `${(env.APP_URL ?? 'http://localhost:5173').replace(/\/$/, '')}/r/${token}`;

export const qrSvg = (url) => QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });

export async function issueToken(client, { roundTripId, voucherId = null, userId = null }) {
  return one(
    `INSERT INTO report_tokens (token, round_trip_id, voucher_id, created_by) VALUES ($1, $2, $3, $4)
     RETURNING id, token, created_at`,
    [newToken(), roundTripId, voucherId, userId],
    client,
  );
}

/** Revokes the live token of a voucher (or of the report header when voucherId is null) and issues a new one. */
export async function regenerateToken(client, { roundTripId, voucherId = null, userId = null }) {
  const old = await one(
    `UPDATE report_tokens SET revoked_at = now(), revoked_by = $3
     WHERE round_trip_id = $1 AND voucher_id IS NOT DISTINCT FROM $2 AND revoked_at IS NULL
     RETURNING id`,
    [roundTripId, voucherId, userId],
    client,
  );
  const fresh = await issueToken(client, { roundTripId, voucherId, userId });
  return { revokedTokenId: old?.id ?? null, ...fresh };
}

/** A live token, or null when it does not exist or was revoked. */
export async function resolveToken(token, client) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
  return one(
    `SELECT id, round_trip_id, voucher_id FROM report_tokens WHERE token = $1 AND revoked_at IS NULL`,
    [token],
    client,
  );
}

export async function logScan({ tokenRow, userId, ip }) {
  await query(
    `INSERT INTO report_scans (token_id, round_trip_id, voucher_id, user_id, ip_address) VALUES ($1, $2, $3, $4, $5)`,
    [tokenRow.id, tokenRow.roundTripId, tokenRow.voucherId, userId ?? null, ip ?? null],
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Draft lock
// ---------------------------------------------------------------------------------------------------------------
/** Locks the round trip for this transaction and rejects the change unless it is still a draft. */
export async function assertDraft(client, id) {
  const rt = await one(`SELECT id, status, route_id, bus_id FROM round_trips WHERE id = $1 FOR UPDATE`, [id], client);
  if (!rt) throw AppError.notFound('Round trip not found');
  if (rt.status !== 'draft') {
    throw new AppError(409, 'This report is finalized and can no longer be changed.', 'FINALIZED');
  }
  return rt;
}

/** "Last updated" on the report moves with every change to its lines. */
export const touch = (client, id) => client.query(`UPDATE round_trips SET updated_at = now() WHERE id = $1`, [id]);

// ---------------------------------------------------------------------------------------------------------------
// Off-route defaults
// ---------------------------------------------------------------------------------------------------------------
/**
 * The off-route lines a new trip gets: route default, else global default; skipped when the category is
 * inactive, switched off for the route, limited to other bus classes, or needs a hostess the bus does not carry.
 */
export async function resolveOffrouteDefaults(client, { routeId, busId }) {
  const { rows } = await query(
    `SELECT c.id AS category_id, c.name, c.sort_order,
            COALESCE(rd.amount, gd.amount, 0) AS amount
     FROM offroute_categories c
     JOIN buses b ON b.id = $2
     LEFT JOIN offroute_defaults rd ON rd.category_id = c.id AND rd.route_id = $1
     LEFT JOIN offroute_defaults gd ON gd.category_id = c.id AND gd.route_id IS NULL
     WHERE c.is_active
       AND COALESCE(rd.is_enabled, gd.is_enabled, FALSE)
       AND (cardinality(c.bus_classes) = 0 OR b.bus_class = ANY (c.bus_classes))
       AND (NOT c.requires_hostess OR b.has_hostess)
     ORDER BY c.sort_order, c.name`,
    [routeId ?? null, busId],
    client,
  );
  return rows;
}

export async function copyOffrouteDefaults(client, { roundTripId, routeId, busId }) {
  const lines = await resolveOffrouteDefaults(client, { routeId, busId });
  for (const l of lines) {
    await client.query(
      `INSERT INTO round_trip_offroute_lines (round_trip_id, category_id, name, amount, default_amount, sort_order)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [roundTripId, l.categoryId, l.name, l.amount, l.sortOrder],
    );
  }
  return lines.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------------------------------
/** Runs queries in parallel on the pool, or one after another on a transaction's single connection. */
async function runAll(client, fns) {
  if (!client) return Promise.all(fns.map((f) => f()));
  const out = [];
  for (const f of fns) out.push(await f());
  return out;
}

async function loadParts(id, client) {
  const trip = await one(
    `SELECT rt.*, b.fleet_no, b.registration_no, b.bus_class, b.has_hostess,
            COALESCE(NULLIF(rt.driver_name, ''), d.full_name) AS driver_label,
            r.code AS route_code, r.name AS route_name,
            fu.full_name AS finalized_by_name
     FROM round_trips rt
     JOIN buses b ON b.id = rt.bus_id
     LEFT JOIN drivers d ON d.id = rt.driver_id
     LEFT JOIN routes r ON r.id = rt.route_id
     LEFT JOIN users fu ON fu.id = rt.finalized_by
     WHERE rt.id = $1`,
    [id],
    client,
  );
  if (!trip) return null;
  const [legs, vouchers, onroute, online, fuel, offroute, tokens] = await runAll(client, [
    () => query(
      `SELECT l.id, l.leg_no, l.title, l.leg_ref, l.trip_id, t.departure_at AS trip_departure_at, t.status AS trip_status
       FROM round_trip_legs l LEFT JOIN trips t ON t.id = l.trip_id WHERE l.round_trip_id = $1 ORDER BY l.leg_no`,
      [id],
      client,
    ),
    // A row copied from a terminal voucher shows that voucher's number (it has none of its own).
    () => query(
      `SELECT v.id, COALESCE(v.voucher_no, tv.voucher_no) AS voucher_no, v.leg_id, v.sort_order, v.terminal_id, v.terminal_name,
              v.departure_at, v.pax_terminal, v.pax_enroute, v.inc_terminal, v.inc_enroute, v.load_amount, v.cargo_amount,
              v.updated_at, v.trip_voucher_id, v.synced_at, v.edited_after_sync, tv.status AS source_status
       FROM terminal_vouchers v LEFT JOIN trip_vouchers tv ON tv.id = v.trip_voucher_id
       WHERE v.round_trip_id = $1 ORDER BY v.sort_order, v.id`,
      [id],
      client,
    ),
    () => query(
      `SELECT l.id, l.voucher_id, l.category_id, l.name, l.amount FROM voucher_onroute_lines l
       JOIN terminal_vouchers v ON v.id = l.voucher_id WHERE v.round_trip_id = $1 ORDER BY l.id`,
      [id],
      client,
    ),
    () => query(
      `SELECT s.id, s.voucher_id, s.platform_id, s.platform_name, s.seats, s.amount FROM voucher_online_sales s
       JOIN terminal_vouchers v ON v.id = s.voucher_id WHERE v.round_trip_id = $1 ORDER BY s.id`,
      [id],
      client,
    ),
    () => query(
      `SELECT id, station, litres, rate, amount FROM round_trip_fuel_entries WHERE round_trip_id = $1 ORDER BY sort_order, id`,
      [id],
      client,
    ),
    () => query(
      `SELECT l.id, l.category_id, l.name, l.amount, l.default_amount, l.sort_order, l.is_overridden, l.overridden_at,
              u.full_name AS overridden_by_name
       FROM round_trip_offroute_lines l LEFT JOIN users u ON u.id = l.overridden_by
       WHERE l.round_trip_id = $1 ORDER BY l.sort_order, l.id`,
      [id],
      client,
    ),
    () => query(
      `SELECT id, token, voucher_id, created_at FROM report_tokens WHERE round_trip_id = $1 AND revoked_at IS NULL`,
      [id],
      client,
    ),
  ]);
  const vs = vouchers.rows.map((v) => ({
    ...v,
    onroute: onroute.rows.filter((l) => l.voucherId === v.id),
    online: online.rows.filter((s) => s.voucherId === v.id),
  }));
  return { trip, legs: legs.rows, vouchers: vs, fuel: fuel.rows, offroute: offroute.rows, tokens: tokens.rows };
}

/**
 * The full report: trip facts, figures, and the header QR.
 * `admin` adds what only the admin screens need (every voucher's token and QR, override details, ids).
 */
export async function buildReport(id, { admin = false, scannedVoucherId = null, client } = {}) {
  const parts = await loadParts(id, client);
  if (!parts) return null;
  const { trip, legs, vouchers, fuel, offroute, tokens } = parts;
  const figures = computeReport(trip, { legs, vouchers, fuel, offroute });

  const headerToken = tokens.find((t) => t.voucherId === null);
  const header = headerToken ? { url: reportUrl(headerToken.token), qrSvg: await qrSvg(reportUrl(headerToken.token)) } : null;

  const report = {
    trip: {
      id: trip.id,
      status: trip.status,
      routeId: trip.routeId,
      routeCode: trip.routeCode,
      routeLabel: trip.routeLabel,
      busId: trip.busId,
      fleetNo: trip.fleetNo ?? trip.registrationNo,
      busClass: trip.busClass,
      hasHostess: trip.hasHostess,
      driverId: trip.driverId,
      driverName: trip.driverLabel,
      fareCollector: trip.fareCollector,
      reportDate: trip.reportDate,
      reportTime: trip.reportTime ? String(trip.reportTime).slice(0, 5) : null,
      distanceKm: trip.distanceKm,
      mobilOil: trip.mobilOil,
      otherExpense: trip.otherExpense,
      otherExpenseNote: trip.otherExpenseNote,
      otherIncome: trip.otherIncome,
      otherIncomeNote: trip.otherIncomeNote,
      cashierName: trip.cashierName,
      cashReceivedAt: trip.cashReceivedAt,
      inchargeName: trip.inchargeName,
      finalizedAt: trip.finalizedAt,
      finalizedByName: trip.finalizedByName,
      createdAt: trip.createdAt,
      updatedAt: trip.updatedAt,
    },
    legs: figures.legs.map((leg) => ({
      id: leg.id,
      legNo: leg.legNo,
      title: leg.title,
      legRef: leg.legRef,
      tripId: leg.tripId ?? null,
      passengers: leg.passengers,
      rows: leg.rows.map((r) => ({
        voucherId: r.id,
        voucherNo: r.voucherNo,
        fromVoucher: Boolean(r.tripVoucherId),
        terminal: r.terminalName,
        departureAt: r.departureAt,
        paxTerminal: r.paxTerminal,
        paxEnroute: r.paxEnroute,
        incTerminal: r.incTerminal,
        incEnroute: r.incEnroute,
        incOnline: r.incOnline,
        totalSale: r.totalSale,
      })),
    })),
    fuel: fuel.map((f) => ({ station: f.station, litres: f.litres, rate: f.rate, amount: f.amount })),
    onroute: figures.onroute.map(({ name, amount }) => ({ name, amount })),
    offroute: offroute.filter((l) => l.amount !== 0).map((l) => ({ name: l.name, amount: l.amount })),
    online: figures.online.map(({ name, seats, amount }) => ({ platform: name, seats, amount })),
    totals: figures.totals,
    expenses: figures.expenses,
    summary: figures.summary,
    header,
    scannedVoucherId,
  };

  if (admin) {
    report.edit = {
      legs,
      vouchers: await Promise.all(
        vouchers.map(async (v) => {
          const t = tokens.find((x) => x.voucherId === v.id);
          return { ...v, token: t?.token ?? null, url: t ? reportUrl(t.token) : null };
        }),
      ),
      fuel,
      offroute,
      headerToken: headerToken?.token ?? null,
      driverName: trip.driverName ?? null, // as typed; trip.driverName above falls back to the driver's name
    };
  }
  return report;
}

/** One voucher for its printed slip: number, terminal, figures, and its own QR. */
export async function voucherSlip(voucherId) {
  const v = await one(
    `SELECT v.*, COALESCE(v.voucher_no, tv.voucher_no) AS voucher_no,
            rt.route_label, rt.report_date, rt.status, b.fleet_no, b.registration_no, l.title AS leg_title, l.leg_ref,
            t.token
     FROM terminal_vouchers v
     LEFT JOIN trip_vouchers tv ON tv.id = v.trip_voucher_id
     JOIN round_trips rt ON rt.id = v.round_trip_id
     JOIN buses b ON b.id = rt.bus_id
     JOIN round_trip_legs l ON l.id = v.leg_id
     LEFT JOIN report_tokens t ON t.voucher_id = v.id AND t.revoked_at IS NULL
     WHERE v.id = $1`,
    [voucherId],
  );
  if (!v) return null;
  const [onroute, online] = await Promise.all([
    query(`SELECT name, amount FROM voucher_onroute_lines WHERE voucher_id = $1 ORDER BY id`, [voucherId]),
    query(`SELECT platform_name, seats, amount FROM voucher_online_sales WHERE voucher_id = $1 ORDER BY id`, [voucherId]),
  ]);
  const incOnline = online.rows.reduce((s, o) => s + o.amount, 0);
  const url = v.token ? reportUrl(v.token) : null;
  return {
    voucherId: v.id,
    voucherNo: v.voucherNo,
    roundTripId: v.roundTripId,
    status: v.status,
    routeLabel: v.routeLabel,
    reportDate: v.reportDate,
    fleetNo: v.fleetNo ?? v.registrationNo,
    legTitle: v.legTitle,
    legRef: v.legRef,
    terminal: v.terminalName,
    departureAt: v.departureAt,
    paxTerminal: v.paxTerminal,
    paxEnroute: v.paxEnroute,
    incTerminal: v.incTerminal,
    incEnroute: v.incEnroute,
    incOnline,
    totalSale: v.incTerminal + v.incEnroute + incOnline,
    loadAmount: v.loadAmount,
    cargoAmount: v.cargoAmount,
    onroute: onroute.rows,
    online: online.rows,
    url,
    qrSvg: url ? await qrSvg(url) : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Vouchers
// ---------------------------------------------------------------------------------------------------------------
async function writeVoucherLines(client, voucherId, { onroute = [], online = [] }) {
  await client.query(`DELETE FROM voucher_onroute_lines WHERE voucher_id = $1`, [voucherId]);
  await client.query(`DELETE FROM voucher_online_sales WHERE voucher_id = $1`, [voucherId]);
  for (const l of onroute) {
    await client.query(
      `INSERT INTO voucher_onroute_lines (voucher_id, category_id, name, amount) VALUES ($1, $2, $3, $4)`,
      [voucherId, l.categoryId ?? null, l.name, l.amount],
    );
  }
  for (const s of online) {
    await client.query(
      `INSERT INTO voucher_online_sales (voucher_id, platform_id, platform_name, seats, amount) VALUES ($1, $2, $3, $4, $5)`,
      [voucherId, s.platformId ?? null, s.platformName, s.seats ?? 0, s.amount],
    );
  }
}

/** Fills in printed names from the lists when only an id was sent. */
export async function resolveLineNames(client, v) {
  const onroute = [];
  for (const l of v.onroute ?? []) {
    let name = l.name;
    if (!name && l.categoryId) name = (await one(`SELECT name FROM onroute_categories WHERE id = $1`, [l.categoryId], client))?.name;
    if (!name) throw AppError.badRequest('Each on-route line needs a category or a name');
    onroute.push({ ...l, name });
  }
  const online = [];
  for (const s of v.online ?? []) {
    let platformName = s.platformName;
    if (!platformName && s.platformId) platformName = (await one(`SELECT name FROM online_platforms WHERE id = $1`, [s.platformId], client))?.name;
    if (!platformName) throw AppError.badRequest('Each online sale needs a platform');
    online.push({ ...s, platformName });
  }
  return { onroute, online };
}

async function terminalName(client, v) {
  if (v.terminalName) return v.terminalName;
  if (v.terminalId) {
    const t = await one(`SELECT c.name AS city FROM terminals t JOIN cities c ON c.id = t.city_id WHERE t.id = $1`, [v.terminalId], client);
    if (t) return t.city;
  }
  throw AppError.badRequest('Choose a terminal or type its name');
}

export async function createVoucher(client, { roundTripId, userId, v }) {
  const leg = await one(`SELECT id FROM round_trip_legs WHERE id = $1 AND round_trip_id = $2`, [v.legId, roundTripId], client);
  if (!leg) throw AppError.badRequest('That leg does not belong to this round trip');
  const name = await terminalName(client, v);
  const lines = await resolveLineNames(client, v);
  const nextOrder = await one(
    `SELECT COALESCE(max(sort_order), 0) + 1 AS n FROM terminal_vouchers WHERE leg_id = $1`,
    [v.legId],
    client,
  );
  // voucher_no is set by the terminal_vouchers_set_no trigger (next_voucher_no()).
  const row = await one(
    `INSERT INTO terminal_vouchers (voucher_no, round_trip_id, leg_id, sort_order, terminal_id, terminal_name, departure_at,
                                    pax_terminal, pax_enroute, inc_terminal, inc_enroute, load_amount, cargo_amount, created_by)
     VALUES ('0000000000', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id, voucher_no`,
    [roundTripId, v.legId, v.sortOrder ?? nextOrder.n, v.terminalId ?? null, name, v.departureAt ?? null,
      v.paxTerminal ?? 0, v.paxEnroute ?? 0, v.incTerminal ?? 0, v.incEnroute ?? 0, v.loadAmount ?? 0, v.cargoAmount ?? 0, userId ?? null],
    client,
  );
  await writeVoucherLines(client, row.id, lines);
  const token = await issueToken(client, { roundTripId, voucherId: row.id, userId });
  return { id: row.id, voucherNo: row.voucherNo, token: token.token };
}

export async function updateVoucher(client, { roundTripId, voucherId, v }) {
  const cur = await one(`SELECT * FROM terminal_vouchers WHERE id = $1 AND round_trip_id = $2`, [voucherId, roundTripId], client);
  if (!cur) throw AppError.notFound('Voucher not found');
  if (v.legId !== undefined) {
    const leg = await one(`SELECT id FROM round_trip_legs WHERE id = $1 AND round_trip_id = $2`, [v.legId, roundTripId], client);
    if (!leg) throw AppError.badRequest('That leg does not belong to this round trip');
  }
  const name = v.terminalName !== undefined || v.terminalId !== undefined
    ? await terminalName(client, { terminalId: v.terminalId ?? cur.terminalId, terminalName: v.terminalName })
    : cur.terminalName;
  await client.query(
    `UPDATE terminal_vouchers SET leg_id = $2, sort_order = $3, terminal_id = $4, terminal_name = $5, departure_at = $6,
            pax_terminal = $7, pax_enroute = $8, inc_terminal = $9, inc_enroute = $10, load_amount = $11, cargo_amount = $12,
            -- A row copied from a terminal voucher and then changed by hand is kept by "Update from vouchers".
            edited_after_sync = (trip_voucher_id IS NOT NULL)
     WHERE id = $1`,
    [voucherId, v.legId ?? cur.legId, v.sortOrder ?? cur.sortOrder, v.terminalId !== undefined ? v.terminalId : cur.terminalId, name,
      v.departureAt !== undefined ? v.departureAt : cur.departureAt, v.paxTerminal ?? cur.paxTerminal, v.paxEnroute ?? cur.paxEnroute,
      v.incTerminal ?? cur.incTerminal, v.incEnroute ?? cur.incEnroute, v.loadAmount ?? cur.loadAmount, v.cargoAmount ?? cur.cargoAmount],
  );
  if (v.onroute !== undefined || v.online !== undefined) {
    const existing = await loadVoucherLines(client, voucherId);
    const lines = await resolveLineNames(client, {
      onroute: v.onroute ?? existing.onroute,
      online: v.online ?? existing.online,
    });
    await writeVoucherLines(client, voucherId, lines);
  }
  return { before: cur };
}

async function loadVoucherLines(client, voucherId) {
  const [onroute, online] = await runAll(client, [
    () => query(`SELECT category_id, name, amount FROM voucher_onroute_lines WHERE voucher_id = $1 ORDER BY id`, [voucherId], client),
    () => query(`SELECT platform_id, platform_name, seats, amount FROM voucher_online_sales WHERE voucher_id = $1 ORDER BY id`, [voucherId], client),
  ]);
  return { onroute: onroute.rows, online: online.rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------------------------------------------
export async function createRoundTrip(client, { userId, input }) {
  const bus = await one(`SELECT id FROM buses WHERE id = $1`, [input.busId], client);
  if (!bus) throw AppError.badRequest('Bus not found');
  const rt = await one(
    `INSERT INTO round_trips (route_id, bus_id, driver_id, driver_name, fare_collector, route_label, report_date, report_time,
                              distance_km, mobil_oil, other_expense, other_expense_note, other_income, other_income_note,
                              cashier_name, cash_received_at, incharge_name, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
     RETURNING id`,
    [input.routeId ?? null, input.busId, input.driverId ?? null, input.driverName ?? null, input.fareCollector ?? null,
      input.routeLabel, input.reportDate, input.reportTime ?? null, input.distanceKm ?? 0, input.mobilOil ?? 0,
      input.otherExpense ?? 0, input.otherExpenseNote ?? null, input.otherIncome ?? 0, input.otherIncomeNote ?? null,
      input.cashierName ?? null, input.cashReceivedAt ?? null, input.inchargeName ?? null, userId ?? null],
    client,
  );
  const legs = input.legs?.length ? input.legs : [];
  for (const [i, leg] of legs.entries()) {
    await client.query(
      `INSERT INTO round_trip_legs (round_trip_id, leg_no, title, leg_ref) VALUES ($1, $2, $3, $4)`,
      [rt.id, i + 1, leg.title, leg.legRef ?? null],
    );
  }
  const offrouteLines = await copyOffrouteDefaults(client, { roundTripId: rt.id, routeId: input.routeId, busId: input.busId });
  await issueToken(client, { roundTripId: rt.id, userId });
  return { id: rt.id, offrouteLines };
}

/** What "apply new defaults" would change on a draft: one entry per line that differs or is new/removed. */
export async function previewDefaults(client, roundTripId) {
  const rt = await one(`SELECT route_id, bus_id FROM round_trips WHERE id = $1`, [roundTripId], client);
  if (!rt) throw AppError.notFound('Round trip not found');
  const defaults = await resolveOffrouteDefaults(client, { routeId: rt.routeId, busId: rt.busId });
  const { rows: lines } = await query(
    `SELECT id, category_id, name, amount, default_amount, is_overridden FROM round_trip_offroute_lines WHERE round_trip_id = $1`,
    [roundTripId],
    client,
  );
  const changes = [];
  for (const d of defaults) {
    const line = lines.find((l) => l.categoryId === d.categoryId);
    if (!line) changes.push({ kind: 'add', categoryId: d.categoryId, name: d.name, from: null, to: d.amount, isOverridden: false });
    else if (line.amount !== d.amount || line.name !== d.name) {
      changes.push({ kind: 'change', lineId: line.id, categoryId: d.categoryId, name: d.name, from: line.amount, to: d.amount, isOverridden: line.isOverridden });
    }
  }
  for (const l of lines) {
    if (l.categoryId && !defaults.some((d) => d.categoryId === l.categoryId)) {
      changes.push({ kind: 'remove', lineId: l.id, categoryId: l.categoryId, name: l.name, from: l.amount, to: null, isOverridden: l.isOverridden });
    }
  }
  return { changes, defaults };
}

/** Applies the current defaults to a draft. Overridden lines are kept unless their ids are listed. */
export async function applyDefaults(client, roundTripId, { includeOverriddenIds = [] } = {}) {
  const { changes, defaults } = await previewDefaults(client, roundTripId);
  const applied = [];
  for (const c of changes) {
    if (c.isOverridden && !includeOverriddenIds.includes(c.lineId)) continue;
    if (c.kind === 'add') {
      const d = defaults.find((x) => x.categoryId === c.categoryId);
      await client.query(
        `INSERT INTO round_trip_offroute_lines (round_trip_id, category_id, name, amount, default_amount, sort_order)
         VALUES ($1, $2, $3, $4, $4, $5)`,
        [roundTripId, c.categoryId, c.name, c.to, d.sortOrder],
      );
    } else if (c.kind === 'change') {
      await client.query(
        `UPDATE round_trip_offroute_lines SET name = $2, amount = $3, default_amount = $3, is_overridden = FALSE,
                overridden_by = NULL, overridden_at = NULL WHERE id = $1`,
        [c.lineId, c.name, c.to],
      );
    } else {
      await client.query(`DELETE FROM round_trip_offroute_lines WHERE id = $1`, [c.lineId]);
    }
    applied.push(c);
  }
  return applied;
}
