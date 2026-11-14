import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, diffDays, isWeekend, adjustToWorkingDay, isValidISODate,
  rateFor, parseCsv, mapRow, DOC_ALIASES, validateAllocation, buildForecast,
  formatISO,
} from '../server/domain.mjs';

const CAL = { holidays: ['2026-11-23'], weekend_rule: 'next', weekend_enabled: false };

test('date helpers', () => {
  assert.equal(addDays('2026-11-14', 7), '2026-11-21');
  assert.equal(diffDays('2026-11-14', '2026-11-21'), 7);
  assert.equal(isWeekend('2026-11-14'), true);  // Saturday
  assert.equal(isWeekend('2026-11-15'), true);  // Sunday
  assert.equal(isWeekend('2026-11-16'), false); // Monday
  assert.equal(isValidISODate('2026-02-30'), false);
  assert.equal(isValidISODate('2026-11-14'), true);
});

test('weekend rule: next', () => {
  // 2026-11-14 is a Saturday
  const r = adjustToWorkingDay('2026-11-14', CAL);
  assert.equal(r.date, '2026-11-16');
  assert.equal(r.shiftDays, 2);
  assert.equal(r.shifted, true);
});

test('weekend rule: prev', () => {
  const r = adjustToWorkingDay('2026-11-14', { ...CAL, weekend_rule: 'prev' });
  assert.equal(r.date, '2026-11-13');
  assert.equal(r.shiftDays, -1);
});

test('weekend rule: nearest ties forward', () => {
  // Sunday 11/15: Saturday and Monday both 1 day away -> forward
  const r = adjustToWorkingDay('2026-11-15', { ...CAL, weekend_rule: 'nearest' });
  assert.equal(r.date, '2026-11-16');
  assert.equal(r.shiftDays, 1);
  // Friday 11/20 is working; untouched
  assert.equal(adjustToWorkingDay('2026-11-20', { ...CAL, weekend_rule: 'nearest' }).shifted, false);
});

test('weekend rule: none leaves date as-is', () => {
  const r = adjustToWorkingDay('2026-11-15', { ...CAL, weekend_rule: 'none' });
  assert.equal(r.date, '2026-11-15');
  assert.equal(r.shifted, false);
});

test('imported holiday shifts even a weekday, bridging a weekend', () => {
  // 2026-11-23 is Monday, imported as holiday; next working day is 11/24
  const r = adjustToWorkingDay('2026-11-23', CAL);
  assert.equal(r.date, '2026-11-24');
  assert.equal(r.shiftDays, 1);
  // 2026-11-22 (Sun) -> holiday Monday -> Tuesday
  const r2 = adjustToWorkingDay('2026-11-22', CAL);
  assert.equal(r2.date, '2026-11-24');
  assert.equal(r2.shiftDays, 2);
});

test('weekend can be a settlement day when enabled', () => {
  const r = adjustToWorkingDay('2026-11-14', { ...CAL, weekend_enabled: true });
  assert.equal(r.date, '2026-11-14');
  // but holidays still shift
  assert.equal(adjustToWorkingDay('2026-11-23', { ...CAL, weekend_enabled: true }).date, '2026-11-24');
});

test('rate resolution: explicit > plan > missing', () => {
  const rates = { USD: 7.15 };
  assert.equal(rateFor('CNY', null, rates, 'CNY'), 1);
  assert.equal(rateFor('USD', 7.2, rates, 'CNY'), 7.2);
  assert.equal(rateFor('USD', null, rates, 'CNY'), 7.15);
  assert.equal(rateFor('GBP', null, rates, 'CNY'), null);
  assert.equal(rateFor('USD', 0, rates, 'CNY'), 7.15);
  assert.equal(rateFor('USD', -1, rates, 'CNY'), 7.15);
});

test('CSV parser handles quotes, commas, CRLF, BOM', () => {
  const csv = '﻿类型,单据号,金额,备注\r\n应收,AR-1,100,"含,逗号"\r\n应收,AR-2,200,"他说""你好"""\r\n';
  const parsed = parseCsv(csv);
  assert.equal(parsed.headers[0], '类型');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].values[3], '含,逗号');
  assert.equal(parsed.rows[1].values[3], '他说"你好"');
});

test('CSV parser rejects unterminated quote', () => {
  assert.ok(parseCsv('a,b\n"x,y').error);
});

test('row mapping via Chinese aliases', () => {
  const rec = mapRow(['单据号', '往来单位', '金额'], ['AR-9', '甲公司', '500'], DOC_ALIASES);
  assert.equal(rec.doc_no, 'AR-9');
  assert.equal(rec.party, '甲公司');
  assert.equal(rec.amount, '500');
});

test('allocation validation: partial allocations within both balances', () => {
  const payment = { kind: 'receipt', currency: 'CNY', amount_original: 500 };
  const document = { kind: 'ar', currency: 'CNY', amount_original: 1000 };
  assert.equal(validateAllocation({ payment, document, amount: 500, activeAllocatedPayment: 0, activeAllocatedDocument: 0 }), null);
  assert.match(validateAllocation({ payment, document, amount: 501, activeAllocatedPayment: 0, activeAllocatedDocument: 0 }), /超过收付款可用余额/);
  assert.match(validateAllocation({ payment, document, amount: 400, activeAllocatedPayment: 200, activeAllocatedDocument: 0 }), /超过收付款可用余额/);
  assert.match(
    validateAllocation({ payment: { ...payment, amount_original: 1000 }, document, amount: 700, activeAllocatedPayment: 0, activeAllocatedDocument: 400 }),
    /超过单据未结金额/,
  );
});

test('allocation validation: currency and direction', () => {
  const p = { kind: 'receipt', currency: 'USD', amount_original: 100 };
  const d = { kind: 'ar', currency: 'CNY', amount_original: 100 };
  assert.match(validateAllocation({ payment: p, document: d, amount: 10, activeAllocatedPayment: 0, activeAllocatedDocument: 0 }), /币种不一致/);
  const d2 = { kind: 'ap', currency: 'USD', amount_original: 100 };
  assert.match(validateAllocation({ payment: p, document: d2, amount: 10, activeAllocatedPayment: 0, activeAllocatedDocument: 0 }), /收款只能核销应收/);
  assert.match(validateAllocation({ payment: p, document: { ...d2, kind: 'ar' }, amount: 0, activeAllocatedPayment: 0, activeAllocatedDocument: 0 }), /大于 0/);
  assert.match(validateAllocation({ payment: p, document: { ...d2, kind: 'ar' }, amount: 'abc', activeAllocatedPayment: 0, activeAllocatedDocument: 0 }), /必须是数字/);
});

function baseInputs(extra = {}) {
  return {
    start: '2026-11-16',
    weeks: 4,
    baseCurrency: 'CNY',
    fxRates: { USD: 7.2 },
    calendar: { holidays: [], weekend_rule: 'next', weekend_enabled: false },
    today: '2026-11-16',
    documents: [],
    payments: [],
    openingBalances: [{ currency: 'CNY', amount: 1000 }],
    ...extra,
  };
}

test('forecast: only outstanding amount is counted, not gross', () => {
  const f = buildForecast(baseInputs({
    documents: [
      { id: 1, kind: 'ar', doc_no: 'A1', party: 'P', currency: 'CNY', amount_original: 500, allocated: 300, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 },
      { id: 2, kind: 'ap', doc_no: 'A2', party: 'S', currency: 'CNY', amount_original: 200, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-19', customer_id: 2 },
    ],
  }));
  assert.equal(f.summary.totalInflow, 200);
  assert.equal(f.summary.totalOutflow, 200);
  assert.equal(f.summary.closingBalance, 1000);
  const item = f.weeks.flatMap((w) => w.items).find((i) => i.ref === 'A1');
  assert.equal(item.outstandingOriginal, 200);
});

test('forecast: settlement date shifts for weekend, due date does not', () => {
  const f = buildForecast(baseInputs({
    documents: [{ id: 1, kind: 'ar', doc_no: 'A1', party: 'P', currency: 'CNY', amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-21', customer_id: 1 }],
  }));
  const item = f.weeks.flatMap((w) => w.items)[0];
  assert.equal(item.expectedDate, '2026-11-21');
  assert.equal(item.settlementDate, '2026-11-23');
  assert.equal(item.dueDate, '2026-11-20');
  assert.equal(item.calendarShiftDays, 2);
});

test('forecast: missing FX is excluded from totals and listed', () => {
  const f = buildForecast(baseInputs({
    documents: [
      { id: 1, kind: 'ar', doc_no: 'U1', party: 'P', currency: 'USD', fx_rate: null, amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 },
      { id: 2, kind: 'ar', doc_no: 'G1', party: 'P', currency: 'GBP', fx_rate: null, amount_original: 50, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 },
    ],
    openingBalances: [{ currency: 'CNY', amount: 1000 }, { currency: 'GBP', amount: 25 }],
  }));
  assert.equal(f.summary.totalInflow, 720); // USD 100 @ 7.2 only
  assert.equal(f.summary.unpricedCount, 2);
  assert.deepEqual(f.summary.unpricedByCurrency.map((b) => b.currency).sort(), ['GBP']);
  assert.equal(f.summary.unpricedByCurrency[0].totalOriginal, 75); // 50 doc + 25 opening
});

test('forecast: explicit zero rate is invalid and falls back to the plan rate (never zero)', () => {
  const f = buildForecast(baseInputs({
    documents: [{ id: 1, kind: 'ar', doc_no: 'Z1', party: 'P', currency: 'USD', fx_rate: 0, amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 }],
  }));
  assert.equal(f.summary.totalInflow, 720);
  assert.equal(f.summary.unpricedCount, 0);
});

test('forecast: explicit negative rate treated as missing when no plan rate exists', () => {
  const f = buildForecast(baseInputs({
    fxRates: {},
    documents: [{ id: 1, kind: 'ar', doc_no: 'Z1', party: 'P', currency: 'USD', fx_rate: -2, amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 }],
  }));
  assert.equal(f.summary.totalInflow, 0);
  assert.equal(f.summary.unpricedCount, 1);
});

test('forecast: duplicate opening snapshots for one currency are not summed', () => {
  const f = buildForecast(baseInputs({
    openingBalances: [
      { currency: 'CNY', amount: 1000, as_of: '2026-11-01' },
      { currency: 'CNY', amount: 2000, as_of: '2026-11-14' },
      { currency: 'USD', amount: 10, as_of: '2026-11-14' },
    ],
  }));
  assert.equal(f.summary.openingBalance, 2072); // 2000 + 10*7.2, not 3072
  assert.equal(f.openingDetail.length, 2);
  assert.equal(f.openingSuperseded.length, 1);
  assert.equal(f.openingSuperseded[0].amount, 1000);
});

test('forecast: when every opening snapshot is after the start, the earliest is used', () => {
  const f = buildForecast(baseInputs({
    start: '2026-11-16',
    openingBalances: [
      { currency: 'CNY', amount: 500, as_of: '2026-12-01' },
      { currency: 'CNY', amount: 900, as_of: '2026-11-20' },
    ],
  }));
  assert.equal(f.summary.openingBalance, 900);
  assert.equal(f.openingSuperseded.length, 1);
});

test('forecast: base-currency switch does not treat the old base as rate 1', () => {
  // A CNY opening balance stored with fx_rate 1 would, after switching the base
  // to USD, convert ¥3,200,000 into $3,200,000 instead of reporting a missing rate.
  const openingBalances = [{ currency: 'CNY', amount: 3200000, fx_rate: null }];
  const asCNY = buildForecast(baseInputs({ baseCurrency: 'CNY', fxRates: { USD: 7.15 }, openingBalances }));
  assert.equal(asCNY.summary.openingBalance, 3200000);

  const asUSD = buildForecast(baseInputs({ baseCurrency: 'USD', fxRates: { USD: 7.15 }, openingBalances }));
  assert.equal(asUSD.summary.openingBalance, 0, 'CNY is unpriced once the base is USD');
  assert.equal(asUSD.summary.unpricedCount, 1);
  assert.equal(asUSD.summary.unpricedByCurrency[0].currency, 'CNY');

  const withRate = buildForecast(baseInputs({ baseCurrency: 'USD', fxRates: { CNY: 0.14 }, openingBalances }));
  assert.equal(withRate.summary.openingBalance, 448000); // 3,200,000 × 0.14
});

test('forecast: a pre-start payment with no rate is still listed as unpriced', () => {
  const f = buildForecast(baseInputs({
    fxRates: {},
    payments: [{ id: 7, kind: 'receipt', ref_no: 'RC-OLD', party: 'P', currency: 'USD', amount_original: 300, allocated: 0, received_date: '2026-11-01' }],
  }));
  assert.equal(f.summary.totalInflow, 0, 'pre-start cash is not re-added on top of the opening balance');
  const u = f.unpriced.find((i) => i.ref === 'RC-OLD');
  assert.ok(u, 'the unpriced cash is surfaced instead of vanishing');
  assert.equal(u.beforePlanStart, true);
  assert.equal(u.amountOriginal, 300);
  assert.equal(f.summary.unpricedByCurrency.find((b) => b.currency === 'USD').totalOriginal, 300);
});

test('forecast: a pre-start payment that can be priced is not double counted', () => {
  const f = buildForecast(baseInputs({
    payments: [{ id: 8, kind: 'receipt', ref_no: 'RC-OK', party: 'P', currency: 'USD', amount_original: 300, allocated: 0, received_date: '2026-11-01' }],
  }));
  assert.equal(f.summary.totalInflow, 0);
  assert.equal(f.unpriced.length, 0);
});

test('forecast: unpriced documents report the open amount, not the gross total', () => {
  const f = buildForecast(baseInputs({
    fxRates: {},
    documents: [{ id: 1, kind: 'ar', doc_no: 'U-PART', party: 'P', currency: 'USD', fx_rate: null, amount_original: 1000, allocated: 600, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 }],
  }));
  const u = f.unpriced.find((i) => i.ref === 'U-PART');
  assert.equal(u.amountOriginal, 400, 'only the unallocated remainder is missing-rate exposure');
  assert.equal(f.summary.unpricedByCurrency[0].totalOriginal, 400);
});

test('forecast: a long holiday run still resolves to a working day', () => {
  const holidays = Array.from({ length: 40 }, (_, i) => addDays('2026-11-16', i));
  const f = buildForecast(baseInputs({
    calendar: { holidays, weekend_rule: 'nearest', weekend_enabled: false },
    documents: [{ id: 1, kind: 'ar', doc_no: 'LONG', party: 'P', currency: 'CNY', amount_original: 10, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-20', customer_id: 1 }],
  }));
  const item = f.weeks.flatMap((w) => w.items)[0];
  assert.ok(!holidays.includes(item.settlementDate), 'settlement lands outside the holiday run');
  assert.equal(item.settlementDate, '2026-11-13'); // Friday before the run and the preceding weekend
  assert.ok(item.calendarShiftDays < 0);
});

test('forecast: negative balance produces gap and deficit week count', () => {
  const f = buildForecast(baseInputs({
    openingBalances: [{ currency: 'CNY', amount: 100 }],
    documents: [{ id: 1, kind: 'ap', doc_no: 'A1', party: 'S', currency: 'CNY', amount_original: 400, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18', customer_id: 1 }],
  }));
  assert.equal(f.summary.minimumBalance, -300);
  assert.equal(f.summary.gap, 300);
  assert.equal(f.summary.deficitWeeks, 4); // balance stays negative through the horizon
  assert.equal(f.summary.minimumBalanceWeek, 0);
});

test('forecast: scenario override changes date, base untouched', () => {
  const docs = [{ id: 1, kind: 'ar', doc_no: 'A1', party: 'P', customer_id: 5, currency: 'CNY', amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18' }];
  const base = buildForecast(baseInputs({ documents: docs }));
  const scen = buildForecast(baseInputs({
    documents: docs,
    scenario: { id: 7, name: 'delay', base: false, overrides: { 1: { expected_date: '2026-12-02' } }, customer_delays: {} },
  }));
  assert.equal(base.weeks.flatMap((w) => w.items)[0].settlementDate, '2026-11-18');
  const shifted = scen.weeks.flatMap((w) => w.items)[0];
  assert.equal(shifted.settlementDate, '2026-12-02');
  assert.equal(shifted.scenarioShiftDays, diffDays('2026-11-18', '2026-12-02'));
});

test('forecast: customer delay applies to all that customer\'s docs', () => {
  const docs = [
    { id: 1, kind: 'ar', doc_no: 'A1', party: 'P', customer_id: 5, currency: 'CNY', amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18' },
    { id: 2, kind: 'ar', doc_no: 'A2', party: 'Q', customer_id: 6, currency: 'CNY', amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18' },
  ];
  const f = buildForecast(baseInputs({ documents: docs, scenario: { id: 1, name: 'x', base: false, overrides: {}, customer_delays: { 5: { delay_days: 10 } } } }));
  const a1 = f.weeks.flatMap((w) => w.items).find((i) => i.ref === 'A1');
  const a2 = f.weeks.flatMap((w) => w.items).find((i) => i.ref === 'A2');
  assert.equal(a1.expectedDate, '2026-11-18');
  assert.equal(a1.scenarioExpectedDate, '2026-11-28');
  assert.equal(a1.scenarioShiftDays, 10);
  assert.equal(a2.scenarioShiftDays, 0);
});

test('forecast: same customer multiple partial allocations do not double count', () => {
  // doc amount 100, allocated 60 across two receipts -> only 40 outstanding
  const f = buildForecast(baseInputs({
    documents: [{ id: 1, kind: 'ar', doc_no: 'A1', party: 'P', customer_id: 1, currency: 'CNY', amount_original: 100, allocated: 60, due_date: '2026-11-20', expected_date: '2026-11-18' }],
  }));
  assert.equal(f.summary.totalInflow, 40);
});

test('forecast: unapplied receipts/payments are surfaced, not double-counted', () => {
  const f = buildForecast(baseInputs({
    documents: [{ id: 1, kind: 'ar', doc_no: 'A1', party: 'P', customer_id: 1, currency: 'CNY', amount_original: 100, allocated: 100, due_date: '2026-11-20', expected_date: '2026-11-18' }],
    payments: [
      { id: 10, kind: 'receipt', ref_no: 'R1', party: 'P', currency: 'CNY', amount_original: 500, allocated: 100, received_date: '2026-11-17' },
    ],
  }));
  assert.equal(f.summary.totalInflow, 500);
  assert.equal(f.summary.unapplied.receipts.count, 1);
  assert.equal(f.summary.unapplied.receipts.totalBase, 400);
});

test('forecast: payments before plan start are excluded (already in opening)', () => {
  const f = buildForecast(baseInputs({
    payments: [{ id: 10, kind: 'receipt', ref_no: 'R0', party: 'P', currency: 'CNY', amount_original: 500, allocated: 0, received_date: '2026-11-10' }],
  }));
  assert.equal(f.summary.totalInflow, 0);
  assert.equal(f.summary.unapplied.receipts.count, 1); // still shown as unapplied
});

test('forecast: an overdue document rolls into week 1 and is flagged', () => {
  // Unlike a payment (actual cash already inside the opening balance), an
  // outstanding document is money that has not moved yet, so it must stay in
  // the forecast even when its expected settlement date is before the start.
  const f = buildForecast(baseInputs({
    openingBalances: [{ currency: 'CNY', amount: 5000 }],
    documents: [{
      id: 1, kind: 'ar', doc_no: 'OLD', party: 'P', currency: 'CNY', amount_original: 1000,
      allocated: 0, due_date: '2026-10-01', expected_date: '2026-10-01', customer_id: 1,
    }],
  }));
  assert.equal(f.weeks[0].items.length, 1);
  assert.equal(f.weeks[0].inflow, 1000);
  assert.equal(f.weeks[0].closing, 6000);
  const item = f.weeks[0].items[0];
  assert.equal(item.beforePlanStart, true);
  assert.equal(item.settlementDate, '2026-10-01');
  assert.equal(f.beyondHorizon.length, 0);
});

test('forecast: week buckets align to start date, not calendar weeks', () => {
  const docs = [0, 1, 6, 7].map((off, i) => ({
    id: i, kind: 'ar', doc_no: `D${i}`, party: 'P', customer_id: 1, currency: 'CNY',
    amount_original: 10, allocated: 0, due_date: '2026-12-01', expected_date: addDays('2026-11-16', off),
  }));
  const f = buildForecast(baseInputs({
    documents: docs,
    calendar: { holidays: [], weekend_rule: 'next', weekend_enabled: true }, // no weekend shifting
  }));
  assert.equal(f.weeks[0].items.length, 3); // offsets 0,1,6 -> week 0
  assert.equal(f.weeks[1].items.length, 1); // offset 7 -> week 1
});

test('forecast: beyond-horizon items are reported, not silently dropped', () => {
  const f = buildForecast(baseInputs({
    documents: [{ id: 1, kind: 'ar', doc_no: 'A1', party: 'P', customer_id: 1, currency: 'CNY', amount_original: 100, allocated: 0, due_date: '2026-12-30', expected_date: '2026-12-30' }],
  }));
  assert.equal(f.summary.totalInflow, 0);
  assert.equal(f.meta.counts.beyondHorizon, 1);
  assert.equal(f.beyondHorizon[0].ref, 'A1');
});

test('forecast: totals equal sum of weekly rows (audit invariant)', () => {
  const f = buildForecast(baseInputs({
    documents: [
      { id: 1, kind: 'ar', doc_no: 'A1', party: 'P', customer_id: 1, currency: 'CNY', amount_original: 123.45, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18' },
      { id: 2, kind: 'ap', doc_no: 'A2', party: 'S', customer_id: 2, currency: 'USD', fx_rate: 7.2, amount_original: 50.5, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-19' },
    ],
  }));
  const sumIn = +f.weeks.reduce((s, w) => s + w.inflow, 0).toFixed(2);
  const sumOut = +f.weeks.reduce((s, w) => s + w.outflow, 0).toFixed(2);
  assert.equal(sumIn, f.summary.totalInflow);
  assert.equal(sumOut, f.summary.totalOutflow);
  const last = f.weeks[f.weeks.length - 1];
  assert.equal(last.closing, f.summary.closingBalance);
});

test('forecast: safety threshold flags weeks', () => {
  const f = buildForecast(baseInputs({
    safetyThreshold: 950,
    documents: [{ id: 1, kind: 'ap', doc_no: 'A1', party: 'S', customer_id: 1, currency: 'CNY', amount_original: 100, allocated: 0, due_date: '2026-11-20', expected_date: '2026-11-18' }],
  }));
  assert.equal(f.summary.belowThresholdWeeks, 4); // 900 < 950 for every week
  assert.equal(f.weeks[0].aboveThreshold, false);
});

test('forecast: rejects invalid start / weeks', () => {
  assert.throws(() => buildForecast(baseInputs({ start: '2026-13-01' })), /起始日无效/);
  assert.throws(() => buildForecast(baseInputs({ weeks: 0 })), /1–52/);
  assert.throws(() => buildForecast(baseInputs({ weeks: 53 })), /1–52/);
});

test('formatISO round trip', () => {
  assert.equal(formatISO(Date.UTC(2026, 10, 14)), '2026-11-14');
});
