import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cashplan-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');

let repo;
before(async () => {
  const { initSchema } = await import('../server/db.mjs');
  initSchema();
  repo = await import('../server/repo.mjs');
  const seed = await import('../server/seed.mjs');
  seed.seedIfEmpty({ force: true });
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function docByNo(no) {
  return repo.listDocuments({ limit: 2000 }).rows.find((d) => d.doc_no === no);
}
function payByRef(ref) {
  return repo.listPayments().find((p) => p.ref_no === ref);
}

let seq = 0;
/** Create an isolated payment so tests never depend on shared seed balances. */
function freshPayment({ kind = 'receipt', amount, currency = 'CNY', party = '华东精密机械有限公司' } = {}) {
  const ref = `T-${kind}-${Date.now()}-${++seq}`;
  const csv = `类型,单号,往来单位,币种,金额,汇率,收付款日期\n${kind === 'receipt' ? '收款' : '付款'},${ref},${party},${currency},${amount},,2026-11-12,\n`;
  const r = repo.importPayments(csv, { filename: 'test.csv' });
  assert.equal(r.accepted.length, 1, 'fresh payment created');
  return payByRef(ref);
}

test('seed creates documents, partial allocations and unapplied payments', () => {
  const docs = repo.listDocuments({ limit: 2000 }).rows;
  assert.ok(docs.length >= 30);
  const ar2601 = docs.find((d) => d.doc_no === 'AR-2601');
  assert.equal(ar2601.amount_original, 486000);
  assert.equal(ar2601.allocated, 300000);
  assert.equal(ar2601.outstanding, 186000);

  const unapplied = repo.listPayments({ onlyUnapplied: true });
  assert.ok(unapplied.some((p) => p.ref_no === 'RC-9006'));
  assert.ok(unapplied.some((p) => p.ref_no === 'PM-8005'));
});

test('a document can receive multiple partial allocations', () => {
  const doc = docByNo('AR-2603'); // 132000 gross, 50000 voided seed alloc -> 132000 outstanding
  const pay1 = freshPayment({ amount: 60000 });
  const pay2 = freshPayment({ amount: 30000 });
  const before = repo.getDocument(doc.id).outstanding;

  const a1 = repo.createAllocation({ payment_id: pay1.id, document_id: doc.id, amount: 40000, allocated_date: '2026-11-14' });
  const a2 = repo.createAllocation({ payment_id: pay2.id, document_id: doc.id, amount: 30000, allocated_date: '2026-11-14' });

  const afterDoc = repo.getDocument(doc.id);
  assert.equal(afterDoc.allocated, before - 62000); // 50000 voided seed alloc not counted
  assert.equal(afterDoc.outstanding, 62000);
  assert.equal(repo.getPayment(pay1.id).available, 20000);
  assert.equal(repo.getPayment(pay2.id).available, 0);

  repo.voidAllocation(a1.id);
  repo.voidAllocation(a2.id);
});

test('one payment can be allocated across multiple documents', () => {
  const pay = payByRef('PM-8005'); // 90000 unapplied payment
  const docs = repo.listDocuments({ kind: 'ap', limit: 2000 }).rows.filter((d) => d.currency === 'CNY' && d.outstanding > 0);
  const a1 = repo.createAllocation({ payment_id: pay.id, document_id: docs[0].id, amount: 50000, allocated_date: '2026-11-14' });
  const a2 = repo.createAllocation({ payment_id: pay.id, document_id: docs[1].id, amount: 40000, allocated_date: '2026-11-14' });
  assert.equal(repo.getPayment(pay.id).available, 0);
  assert.equal(repo.listAllocationsForPayment(pay.id, { includeVoided: false }).length, 2);
  repo.voidAllocation(a1.id);
  repo.voidAllocation(a2.id);
});

test('allocation cannot exceed either side available balance', () => {
  const doc = docByNo('AR-2614'); // 88000 outstanding
  const pay = freshPayment({ amount: 200000 });
  assert.throws(
    () => repo.createAllocation({ payment_id: pay.id, document_id: doc.id, amount: 89000, allocated_date: '2026-11-14' }),
    /超过单据未结金额/,
  );
  const small = freshPayment({ amount: 1000 });
  assert.throws(
    () => repo.createAllocation({ payment_id: small.id, document_id: doc.id, amount: 2000, allocated_date: '2026-11-14' }),
    /超过收付款可用余额/,
  );
});

test('allocation rejects currency mismatch and wrong direction', () => {
  const doc = docByNo('AR-2613'); // JPY
  const pay = payByRef('RC-9006'); // CNY
  assert.throws(() => repo.createAllocation({ payment_id: pay.id, document_id: doc.id, amount: 100, allocated_date: '2026-11-14' }), /币种不一致/);
  const apDoc = docByNo('AP-3604');
  assert.throws(() => repo.createAllocation({ payment_id: pay.id, document_id: apDoc.id, amount: 100, allocated_date: '2026-11-14' }), /收款只能核销应收/);
});

test('voiding restores outstanding amounts and restore re-applies', () => {
  const doc = docByNo('AR-2605');
  const before = repo.getDocument(doc.id);
  const pay = freshPayment({ amount: 20000 });
  const alloc = repo.createAllocation({ payment_id: pay.id, document_id: doc.id, amount: 20000, allocated_date: '2026-11-14' });

  let d = repo.getDocument(doc.id);
  assert.equal(d.outstanding, before.outstanding - 20000);
  assert.equal(repo.getPayment(pay.id).available, 0);

  repo.voidAllocation(alloc.id);
  d = repo.getDocument(doc.id);
  assert.equal(d.outstanding, before.outstanding);
  assert.equal(repo.getPayment(pay.id).available, 20000);

  repo.restoreAllocation(alloc.id);
  d = repo.getDocument(doc.id);
  assert.equal(d.outstanding, before.outstanding - 20000);

  repo.voidAllocation(alloc.id);
});

test('voiding twice is rejected; restoring an active allocation is rejected', () => {
  const a = repo.createAllocation({
    payment_id: payByRef('RC-9006').id,
    document_id: docByNo('AR-2609').id,
    amount: 1000,
    allocated_date: '2026-11-14',
  });
  repo.voidAllocation(a.id);
  assert.throws(() => repo.voidAllocation(a.id), /已撤销/);
  repo.restoreAllocation(a.id);
  assert.throws(() => repo.restoreAllocation(a.id), /未撤销/);
  repo.voidAllocation(a.id);
});

test('restore fails when balance was consumed by another allocation meanwhile', () => {
  const doc = docByNo('AR-2614'); // 88000 outstanding
  const pay = freshPayment({ amount: 88000 });
  const a1 = repo.createAllocation({ payment_id: pay.id, document_id: doc.id, amount: 88000, allocated_date: '2026-11-14' });
  repo.voidAllocation(a1.id);
  // someone else consumes the freed amount
  const a2 = repo.createAllocation({ payment_id: pay.id, document_id: doc.id, amount: 88000, allocated_date: '2026-11-14' });
  assert.throws(() => repo.restoreAllocation(a1.id), /无法恢复/);
  repo.voidAllocation(a2.id);
});

test('document import dedupes on re-import', () => {
  const csv = `类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日,备注
应收,AR-IMP-1,华东精密机械有限公司,CNY,50000,,2026-11-01,2026-11-20,2026-11-22,测试
应付,AP-IMP-1,宝钢原材料供应有限公司,CNY,30000,,2026-11-01,2026-11-20,2026-11-22,测试
应收,AR-IMP-BAD,,CNY,-5,,2026-11-01,2026-11-20,2026-11-22,缺单位
应收,AR-IMP-BAD2,甲公司,CNY,abc,,2026-11-01,2026-11-20,2026-11-22,金额错误
`;
  const first = repo.importDocuments(csv, { filename: 't.csv' });
  assert.equal(first.accepted.length, 2);
  assert.equal(first.rejected.length, 2);

  const second = repo.importDocuments(csv, { filename: 't.csv' });
  assert.equal(second.accepted.length, 0);
  assert.equal(second.skipped.length, 2);
  assert.equal(second.rejected.length, 2);

  // only two rows actually exist
  const all = repo.listDocuments({ limit: 2000 }).rows;
  assert.equal(all.filter((d) => d.doc_no.startsWith('AR-IMP') || d.doc_no.startsWith('AP-IMP')).length, 2);
});

test('payment import dedupes and lands in the unapplied pool', () => {
  const csv = `类型,单号,往来单位,币种,金额,汇率,收付款日期,备注
收款,RC-IMP-1,华东精密机械有限公司,CNY,25000,,2026-11-10,测试
`;
  const r1 = repo.importPayments(csv, { filename: 'p.csv' });
  assert.equal(r1.accepted.length, 1);
  const r2 = repo.importPayments(csv, { filename: 'p.csv' });
  assert.equal(r2.skipped.length, 1);
  const imported = payByRef('RC-IMP-1');
  assert.equal(imported.available, 25000);
});

test('opening balance import updates on changed amount, skips on identical', () => {
  const csv1 = '币种,金额,余额日期\nCNY,3200000,2026-11-14\n';
  const r1 = repo.importOpening(csv1);
  assert.equal(r1.accepted.length, 0);
  assert.equal(r1.skipped.length, 1); // unchanged seed value

  const csv2 = '币种,金额,余额日期\nCNY,3300000,2026-11-14\n';
  const r2 = repo.importOpening(csv2);
  assert.equal(r2.accepted.length, 1);
  assert.equal(r2.accepted[0].updated, true);
  const opening = repo.listOpeningBalances().find((o) => o.currency === 'CNY');
  assert.equal(opening.amount, 3300000);
  // restore
  repo.importOpening(csv1);
});

test('imports with a blank rate follow the plan rate instead of freezing it', () => {
  const csv = `类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日
应收,AR-FXBLANK,某公司,USD,100,,2026-11-01,2026-11-20,2026-11-20
`;
  const r = repo.importDocuments(csv);
  assert.equal(r.accepted.length, 1);
  const doc = docByNo('AR-FXBLANK');
  assert.equal(doc.fx_rate, null, 'plan rate is not persisted onto the document');

  const before = repo.runForecast({ scenarioId: 0 });
  const itemBefore = before.weeks.flatMap((w) => w.items).find((i) => i.ref === 'AR-FXBLANK');
  assert.ok(itemBefore, 'blank-rate document is priced by the plan rate');

  const original = repo.getSettings().fx_rates;
  repo.updateSettings({ fx_rates: { ...original, USD: 9 } });
  try {
    const after = repo.runForecast({ scenarioId: 0 });
    const itemAfter = after.weeks.flatMap((w) => w.items).find((i) => i.ref === 'AR-FXBLANK');
    assert.equal(itemAfter.rate, 9, 'later rate edits in Settings reach the document');
    assert.equal(itemAfter.amountBase, 900);
  } finally {
    repo.updateSettings({ fx_rates: original });
  }
});

test('opening balance import leaves non-base rates on the plan', async () => {
  const start = repo.getSettings().plan_start;
  const csv = `币种,金额,余额日期\nHKD,1000,${start}\n`;
  const r = repo.importOpening(csv);
  assert.equal(r.accepted.length, 1);
  const opening = repo.listOpeningBalances().find((o) => o.currency === 'HKD');
  assert.equal(opening.fx_rate, null, 'imported opening keeps following the plan rate');

  const before = repo.runForecast({ scenarioId: 0 });
  const original = repo.getSettings().fx_rates;
  repo.updateSettings({ fx_rates: { ...original, HKD: 1 } });
  try {
    const after = repo.runForecast({ scenarioId: 0 });
    assert.equal(after.summary.openingBalance - before.summary.openingBalance, 1000 * 1 - 1000 * (original.HKD ?? 0));
  } finally {
    repo.updateSettings({ fx_rates: original });
    const { getDb } = await import('../server/db.mjs');
    getDb().prepare("DELETE FROM opening_balances WHERE currency = 'HKD'").run();
  }
});

test('import rejects invalid currency, date and rate', () => {
  const csv = `类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日
应收,AR-E1,某公司,US,100,,2026-11-01,2026-11-20,2026-11-20
应收,AR-E2,某公司,CNY,100,,2026-11-01,2026-02-30,2026-11-20
应付,AP-E3,某公司,USD,100,0,2026-11-01,2026-11-20,2026-11-20
应付,AP-E4,某公司,USD,100,,2026-11-01,2026-11-20,2026-11-20
`;
  const r = repo.importDocuments(csv);
  assert.equal(r.rejected.length, 3); // invalid currency + invalid date + zero rate
  assert.equal(r.accepted.length, 1); // blank rate -> falls back to plan rate
});

test('scenario create/update does not mutate documents', () => {
  const doc = docByNo('AR-2601');
  const originalDate = doc.expected_date;
  const scen = repo.createScenario({
    name: '测试情景',
    customer_delays: { 1: { delay_days: 20, reason: '测试' } },
    overrides: [{ document_id: doc.id, expected_date: '2026-12-31', reason: '测试' }],
  });
  assert.equal(scen.name, '测试情景');
  const after = repo.getDocument(doc.id);
  assert.equal(after.expected_date, originalDate); // untouched

  const f = repo.runForecast({ scenarioId: scen.id });
  const item = f.weeks.flatMap((w) => w.items).find((i) => i.id === doc.id);
  if (item) assert.equal(item.scenarioExpectedDate, '2026-12-31');

  repo.updateScenario(scen.id, { name: '改名', overrides: [], customer_delays: {} });
  assert.equal(repo.getScenario(scen.id).name, '改名');
  repo.deleteScenario(scen.id);
});

test('base scenario cannot be edited or deleted', () => {
  const base = repo.listScenarios().find((s) => s.base);
  assert.throws(() => repo.updateScenario(base.id, { name: 'x' }), /基准方案不能修改/);
  assert.throws(() => repo.deleteScenario(base.id), /基准方案不能删除/);
});

test('audit invariants hold on seeded data', async () => {
  const f = repo.runForecast({});
  const docIds = repo.listDocuments({ limit: 2000 }).rows.map((d) => d.id);
  for (const d of repo.listDocuments({ limit: 2000 }).rows) {
    assert.ok(d.allocated <= d.amount_original + 0.005, `${d.doc_no} over-allocated`);
  }
  for (const p of repo.listPayments()) {
    assert.ok(p.allocated <= p.amount_original + 0.005, `${p.ref_no} over-allocated`);
  }
  assert.equal(+f.weeks.reduce((s, w) => s + w.inflow, 0).toFixed(2), f.summary.totalInflow);
  assert.equal(+f.weeks.reduce((s, w) => s + w.outflow, 0).toFixed(2), f.summary.totalOutflow);
  assert.ok(docIds.length > 0);
});

test('calendar change re-shifts settlement dates', () => {
  const cal = repo.getCalendar();
  const original = cal.holidays.slice();
  const doc = docByNo('AR-2603');
  // make its expected date a holiday
  repo.updateCalendar(cal.id, { holidays: [...original, doc.expected_date] });
  const f = repo.runForecast({});
  const item = f.weeks.flatMap((w) => w.items).find((i) => i.id === doc.id);
  assert.ok(item.settlementDate !== doc.expected_date);
  repo.updateCalendar(cal.id, { holidays: original });
});

test('switching the active calendar is persisted and changes the forecast', () => {
  const cals = repo.listCalendars();
  const def = cals.find((c) => c.is_default);
  const other = cals.find((c) => c.id !== def.id);
  assert.ok(other, 'a second calendar exists');

  repo.updateCalendar(other.id, { is_default: true });
  try {
    const active = repo.getCalendar();
    assert.equal(active.id, other.id, 'the default calendar actually changed');
    const f = repo.runForecast({});
    assert.equal(f.meta.calendar.id, other.id, 'forecast uses the newly selected calendar');
  } finally {
    repo.updateCalendar(def.id, { is_default: true });
  }
  assert.equal(repo.getCalendar().id, def.id);
});

test('import dedupe key includes currency, so same-numbered USD and CNY docs both land', () => {
  const row = (ccy) => `类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日\n应收,DUP-CCY,某公司,${ccy},1000,,2026-11-01,2026-11-20,2026-11-20\n`;
  const cny = repo.importDocuments(row('CNY'));
  assert.equal(cny.accepted.length, 1);
  const usd = repo.importDocuments(row('USD'));
  assert.equal(usd.accepted.length, 1, 'the USD document is not mistaken for the CNY one');
  assert.equal(usd.skipped.length, 0);
  const docs = repo.listDocuments({ limit: 2000 }).rows.filter((d) => d.doc_no === 'DUP-CCY');
  assert.deepEqual(docs.map((d) => d.currency).sort(), ['CNY', 'USD']);
  // and a true repeat of the USD row is still skipped
  const again = repo.importDocuments(row('USD'));
  assert.equal(again.accepted.length, 0);
  assert.equal(again.skipped.length, 1);
});

test('re-importing a document with a corrected expected date does not duplicate it', () => {
  const mk = (exp) => `类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日\n应收,EXP-REV,某公司,CNY,500,,2026-11-01,2026-11-20,${exp}\n`;
  assert.equal(repo.importDocuments(mk('2026-11-20')).accepted.length, 1);
  const second = repo.importDocuments(mk('2026-11-25'));
  assert.equal(second.accepted.length, 0, 'expected date is not part of the dedupe key');
  assert.equal(second.skipped.length, 1);
});

test('a rejected scenario edit leaves the stored assumptions untouched', () => {
  const scen = repo.createScenario({
    name: '回滚测试',
    customer_delays: { 1: 5, 3: 7 },
    overrides: [],
  });
  assert.deepEqual(Object.keys(scen.customer_delays).sort(), ['1', '3']);

  assert.throws(
    () => repo.updateScenario(scen.id, { customer_delays: { 2: 9, 999999: 3 } }),
    /不存在/,
  );
  const after = repo.getScenario(scen.id);
  assert.deepEqual(Object.keys(after.customer_delays).sort(), ['1', '3'], 'old delays survived the failed edit');
  assert.equal(after.customer_delays['1'].delay_days, 5);

  // a bad override must not wipe existing overrides either
  const doc = docByNo('AR-2601');
  repo.updateScenario(scen.id, { overrides: [{ document_id: doc.id, expected_date: '2026-12-01' }] });
  assert.throws(
    () => repo.updateScenario(scen.id, { overrides: [{ document_id: 999999, expected_date: '2026-12-05' }] }),
    /不存在/,
  );
  assert.equal(repo.getScenario(scen.id).overrides.length, 1);
  repo.deleteScenario(scen.id);
});

test('a failed createScenario leaves no orphan scenario behind', () => {
  const before = repo.listScenarios().length;
  assert.throws(
    () => repo.createScenario({ name: '坏情景', customer_delays: { 1: 3, 999999: 1 } }),
    /不存在/,
  );
  assert.equal(repo.listScenarios().length, before, 'no half-written scenario');
});

test('requesting the base scenario by id keeps its base flag', () => {
  const base = repo.listScenarios().find((s) => s.base);
  const inputs = repo.forecastInputs({ scenarioId: base.id });
  assert.equal(inputs.scenario.base, true);
  const f = repo.runForecast({ scenarioId: base.id });
  assert.equal(f.meta.scenario.base, true);
  // the baseline result must equal the default (no scenario) result
  assert.equal(f.summary.minimumBalance, repo.runForecast({ scenarioId: 0 }).summary.minimumBalance);
});

test('missing rate documents appear in unpriced list and not totals', () => {
  // ensure AR-2613 has no explicit rate and the plan has no JPY rate
  const f = repo.runForecast({});
  assert.ok(f.unpriced.some((u) => u.ref === 'AR-2613')); // JPY, no plan rate
  const ar2613 = docByNo('AR-2613');
  assert.ok(!f.weeks.flatMap((w) => w.items).some((i) => i.source === 'document' && i.id === ar2613.id));
  const jpyBucket = f.summary.unpricedByCurrency.find((b) => b.currency === 'JPY');
  assert.ok(jpyBucket, 'JPY bucket present');
});

test('forecast reflects voiding: outstanding goes up again', () => {
  const f1 = repo.runForecast({});
  const doc = docByNo('AR-2601');
  const val1 = f1.summary.totalInflow;
  const alloc = repo.createAllocation({
    payment_id: payByRef('RC-9006').id, document_id: doc.id, amount: 50000, allocated_date: '2026-11-14',
  });
  const f2 = repo.runForecast({});
  assert.ok(f2.summary.totalInflow < val1, 'allocating reduces outstanding inflow');
  repo.voidAllocation(alloc.id);
  const f3 = repo.runForecast({});
  assert.equal(f3.summary.totalInflow, val1);
});
