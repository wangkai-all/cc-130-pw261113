/**
 * Pure domain logic for the cash-flow planner.
 * No database or HTTP dependencies — everything here is unit-testable.
 */

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n) {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidISODate(value) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function parseISO(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

export function formatISO(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, days) {
  return formatISO(parseISO(dateStr) + days * 86400000);
}

export function diffDays(from, to) {
  return Math.round((parseISO(to) - parseISO(from)) / 86400000);
}

export function isWeekend(dateStr) {
  const dow = new Date(parseISO(dateStr)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isWorkingDay(dateStr, calendar = {}) {
  const holidays = calendar.holidays instanceof Set ? calendar.holidays : new Set(calendar.holidays || []);
  if (holidays.has(dateStr)) return false;
  if (!calendar.weekend_enabled && isWeekend(dateStr)) return false;
  return true;
}

/**
 * Shift a date to a working day using the calendar's rule.
 * Weekend days count as non-working only when weekend_enabled is false.
 * Holidays are always non-working.
 * Rules: 'none' (no shift) | 'next' | 'prev' | 'nearest' (ties go forward).
 */
export function adjustToWorkingDay(dateStr, calendar = {}) {
  const rule = calendar.weekend_rule || 'next';
  if (!isValidISODate(dateStr)) throw new Error(`无效日期: ${dateStr}`);
  if (rule === 'none') return { date: dateStr, shiftDays: 0, shifted: false };
  const holidays = calendar.holidays instanceof Set ? calendar.holidays : new Set(calendar.holidays || []);
  const cal = { holidays, weekend_enabled: !!calendar.weekend_enabled, weekend_rule: rule };
  if (isWorkingDay(dateStr, cal)) return { date: dateStr, shiftDays: 0, shifted: false };

  if (rule === 'nearest') {
    // keep scanning long enough to clear a long holiday run (e.g. a multi-week
    // imported shutdown) instead of silently returning the original non-working day
    for (let dist = 1; dist <= 400; dist++) {
      const forward = addDays(dateStr, dist);
      if (isWorkingDay(forward, cal)) return { date: forward, shiftDays: dist, shifted: true };
      const backward = addDays(dateStr, -dist);
      if (isWorkingDay(backward, cal)) return { date: backward, shiftDays: -dist, shifted: true };
    }
    return { date: dateStr, shiftDays: 0, shifted: false };
  }

  const step = rule === 'prev' ? -1 : 1;
  let cursor = dateStr;
  for (let guard = 0; guard < 400; guard++) {
    cursor = addDays(cursor, step);
    if (isWorkingDay(cursor, cal)) {
      return { date: cursor, shiftDays: diffDays(dateStr, cursor), shifted: true };
    }
  }
  return { date: dateStr, shiftDays: 0, shifted: false };
}

export function rateFor(currency, explicitRate, rates, baseCurrency) {
  if (currency === baseCurrency) return 1;
  const explicit = Number(explicitRate);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const plan = Number(rates?.[currency]);
  if (Number.isFinite(plan) && plan > 0) return plan;
  return null;
}

export function fxStatus(rate) {
  return rate == null ? 'missing' : 'ok';
}

/**
 * RFC4180-ish CSV parser. Returns { headers, rows: [{ line, values }] }.
 * Accepts quoted fields, escaped quotes, CRLF, and a UTF-8 BOM.
 */
export function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { headers: [], rows: [], error: '内容为空' };
  }
  const src = text.replace(/^﻿/, '');
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((v) => v.trim() !== '')) {
        rows.push({ line: rowStartLine, values: row.map((v) => v.trim()) });
      }
      row = [];
      line++;
      rowStartLine = line;
    } else {
      field += ch;
    }
  }
  if (inQuotes) return { headers: [], rows: [], error: 'CSV 引号未闭合' };
  row.push(field);
  if (row.some((v) => v.trim() !== '')) rows.push({ line: rowStartLine, values: row.map((v) => v.trim()) });
  if (!rows.length) return { headers: [], rows: [], error: '内容为空' };

  const headers = rows[0].values.map((h) => h.trim());
  return { headers, rows: rows.slice(1) };
}

/** Map a CSV row to an object, tolerating Chinese/English header aliases. */
export function mapRow(headers, values, aliases) {
  const out = {};
  headers.forEach((h, idx) => {
    const key = aliases[h] || aliases[h.toLowerCase()] || h;
    out[key] = values[idx] ?? '';
  });
  return out;
}

export const DOC_ALIASES = {
  kind: 'kind', 类型: 'kind', type: 'kind',
  doc_no: 'doc_no', 单据号: 'doc_no', document_no: 'doc_no', 单号: 'doc_no',
  party: 'party', 往来单位: 'party', 客户: 'party', 供应商: 'party', customer: 'party',
  currency: 'currency', 币种: 'currency',
  amount: 'amount', 金额: 'amount',
  fx_rate: 'fx_rate', 汇率: 'fx_rate', rate: 'fx_rate',
  issue_date: 'issue_date', 开票日期: 'issue_date',
  due_date: 'due_date', 到期日: 'due_date', 账面到期日: 'due_date',
  expected_date: 'expected_date', 预计结算日: 'expected_date',
  note: 'note', 备注: 'note',
};

export const PAYMENT_ALIASES = {
  kind: 'kind', 类型: 'kind', type: 'kind',
  ref_no: 'ref_no', 单号: 'ref_no', 收款单号: 'ref_no', 付款单号: 'ref_no',
  party: 'party', 往来单位: 'party', 客户: 'party', 供应商: 'party',
  currency: 'currency', 币种: 'currency',
  amount: 'amount', 金额: 'amount',
  fx_rate: 'fx_rate', 汇率: 'fx_rate', rate: 'fx_rate',
  received_date: 'received_date', 收付款日期: 'received_date', 日期: 'received_date',
  note: 'note', 备注: 'note',
};

export const OPENING_ALIASES = {
  currency: 'currency', 币种: 'currency',
  amount: 'amount', 金额: 'amount',
  as_of: 'as_of', 余额日期: 'as_of', date: 'as_of',
};

/**
 * Business key for import dedupe. Currency is part of the key: a USD document
 * numbered the same as a CNY one is a different document, and without this it
 * would be silently swallowed as a "duplicate". Amount and due date stay in the
 * key, but the planned settlement date deliberately does not — re-importing a
 * corrected expected date must not create a second copy that double-counts.
 */
export function docImportKey(doc) {
  return [
    'doc', doc.kind, String(doc.doc_no).trim(), String(doc.party).trim(),
    String(doc.currency || '').toUpperCase(),
    round2(Number(doc.amount)).toFixed(2), doc.due_date,
  ].join('|');
}

export function paymentImportKey(pay) {
  return [
    'pay', pay.kind, String(pay.ref_no).trim(), String(pay.party).trim(),
    String(pay.currency || '').toUpperCase(),
    round2(Number(pay.amount)).toFixed(2), pay.received_date,
  ].join('|');
}

/** Validate an allocation request against both sides' available balances. */
export function validateAllocation({ payment, document, amount, activeAllocatedPayment, activeAllocatedDocument }) {
  if (!payment) return '收付款单不存在';
  if (!document) return '单据不存在';
  if (payment.kind === 'receipt' && document.kind !== 'ar') return '收款只能核销应收单据';
  if (payment.kind === 'payment' && document.kind !== 'ap') return '付款只能核销应付单据';
  if (payment.currency !== document.currency) {
    return `币种不一致：${payment.currency} 收付款不能核销 ${document.currency} 单据`;
  }
  const amt = Number(amount);
  if (!Number.isFinite(amt)) return '核销金额必须是数字';
  if (round2(amt) <= 0) return '核销金额必须大于 0';
  const paymentAvailable = round2(payment.amount_original - activeAllocatedPayment);
  const documentOutstanding = round2(document.amount_original - activeAllocatedDocument);
  if (round2(amt) > round2(paymentAvailable + 0.001)) {
    return `超过收付款可用余额（可用 ${paymentAvailable.toFixed(2)} ${payment.currency}）`;
  }
  if (round2(amt) > round2(documentOutstanding + 0.001)) {
    return `超过单据未结金额（未结 ${documentOutstanding.toFixed(2)} ${document.currency}）`;
  }
  return null;
}

/**
 * Build the weekly forecast. Inputs are plain objects so this is deterministic
 * and easy to test. Documents/payments carry an `allocated` field with the
 * active (non-voided) allocation total in their own currency.
 */
export function buildForecast({
  start,
  weeks = 13,
  documents = [],
  payments = [],
  openingBalances = [],
  calendar = {},
  scenario = null,
  fxRates = {},
  baseCurrency = 'CNY',
  safetyThreshold = 0,
  today = formatISO(Date.now()),
}) {
  if (!isValidISODate(start)) throw new Error('计划起始日无效');
  if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new Error('计划周数必须在 1–52 之间');
  const end = addDays(start, weeks * 7 - 1);
  const holidaySet = new Set(calendar.holidays || []);
  const cal = { ...calendar, holidays: holidaySet };
  const overrides = scenario?.overrides || {};
  const delays = scenario?.customer_delays || {};
  const isBase = !scenario || !scenario.id || !!scenario.base;
  const weekList = Array.from({ length: weeks }, (_, i) => ({
    index: i,
    start: addDays(start, i * 7),
    end: addDays(start, i * 7 + 6),
    inflow: 0,
    outflow: 0,
    net: 0,
    opening: 0,
    closing: 0,
    items: [],
  }));

  const unpriced = [];
  const beyondHorizon = [];
  const itemsById = new Map();

  // Opening balances are periodic snapshots, so several rows can exist for one
  // currency (different as_of dates). Only one snapshot per currency may seed
  // the opening cash — summing them would double-count the same bank balance.
  // Preference: the latest snapshot on/before the plan start; if every snapshot
  // is dated after the start, the earliest of those.
  const openingByCurrency = new Map();
  const openingSuperseded = [];
  for (const ob of openingBalances) {
    const asOf = ob.as_of || '';
    const prev = openingByCurrency.get(ob.currency);
    if (!prev) { openingByCurrency.set(ob.currency, ob); continue; }
    const prevAsOf = prev.as_of || '';
    const prevUsable = !prevAsOf || prevAsOf <= start;
    const thisUsable = !asOf || asOf <= start;
    const better = prevUsable === thisUsable
      ? (prevUsable ? asOf > prevAsOf : asOf < prevAsOf)
      : thisUsable;
    if (better) { openingSuperseded.push(prev); openingByCurrency.set(ob.currency, ob); }
    else openingSuperseded.push(ob);
  }

  let openingTotal = 0;
  const openingDetail = [];
  for (const ob of openingByCurrency.values()) {
    const rate = rateFor(ob.currency, ob.fx_rate, fxRates, baseCurrency);
    if (rate == null) {
      const item = {
        source: 'opening', id: ob.id, ref: ob.currency + ' 期初余额',
        party: '', currency: ob.currency, amountOriginal: round2(ob.amount),
        rate: null, amountBase: null, date: ob.as_of, reason: 'missing_rate',
      };
      unpriced.push(item);
      continue;
    }
    const amountBase = round2(ob.amount * rate);
    openingTotal = round2(openingTotal + amountBase);
    openingDetail.push({
      id: ob.id,
      currency: ob.currency,
      amountOriginal: round2(ob.amount),
      rate,
      amountBase,
      asOf: ob.as_of || null,
      rateSource: ob.currency === baseCurrency ? 'base' : (Number(ob.fx_rate) > 0 ? 'explicit' : 'plan'),
    });
  }
  openingDetail.sort((a, b) => b.amountBase - a.amountBase);

  // A document expected to settle before the plan start is NOT already in the
  // opening balance (it is still outstanding, otherwise it would be fully
  // allocated), so it still counts as expected money. It rolls into week 1 so
  // an overdue receivable/payable is not silently dropped from the forecast.
  const weekIndexFor = (date) => {
    if (date < start) return 0;
    if (date > end) return -1;
    return Math.floor(diffDays(start, date) / 7);
  };

  for (const doc of documents) {
    const outstanding = round2(doc.amount_original - (doc.allocated || 0));
    if (outstanding <= 0.005) continue;

    let desired = doc.expected_date;
    let scenarioShift = 0;
    let overrideReason = null;
    if (!isBase) {
      const ov = overrides[doc.id];
      if (ov) {
        desired = ov.expected_date;
        overrideReason = ov.reason || null;
      } else {
        const cfg = delays[doc.customer_id];
        const delay = Number(typeof cfg === 'object' && cfg !== null ? cfg.delay_days : cfg) || 0;
        if (delay) desired = addDays(desired, delay);
      }
      scenarioShift = diffDays(doc.expected_date, desired);
    }
    const adjusted = adjustToWorkingDay(desired, cal);
    const settlement = adjusted.date;
    const rate = rateFor(doc.currency, doc.fx_rate, fxRates, baseCurrency);
    const item = {
      source: 'document',
      id: doc.id,
      kind: doc.kind,
      ref: doc.doc_no,
      party: doc.party,
      customerId: doc.customer_id ?? null,
      currency: doc.currency,
      amountOriginal: round2(doc.amount_original),
      allocatedOriginal: round2(doc.allocated || 0),
      outstandingOriginal: outstanding,
      rate,
      amountBase: null,
      dueDate: doc.due_date,
      expectedDate: doc.expected_date,
      scenarioExpectedDate: desired,
      settlementDate: settlement,
      weekStart: null,
      beforePlanStart: settlement < start,
      calendarShiftDays: adjusted.shiftDays,
      scenarioShiftDays: scenarioShift,
      overrideReason,
      overdue: doc.due_date < today,
      overdueDays: doc.due_date < today ? diffDays(doc.due_date, today) : 0,
      direction: doc.kind === 'ar' ? 'in' : 'out',
      unpriced: rate == null,
    };
    item.key = `doc:${doc.id}`;
    itemsById.set(item.key, item);
    if (rate == null) {
      // Report the still-open amount, not the gross document total: an already
      // allocated portion is money that has moved and must not be re-listed as
      // missing-rate exposure (it is also counted on the payment side).
      unpriced.push({ ...item, amountOriginal: outstanding, reason: 'missing_rate' });
      continue;
    }
    item.amountBase = round2(outstanding * rate);
    const idx = weekIndexFor(settlement);
    if (idx < 0) { beyondHorizon.push(item); continue; }
    item.weekStart = weekList[idx].start;
    weekList[idx].items.push(item);
    if (item.direction === 'in') weekList[idx].inflow = round2(weekList[idx].inflow + item.amountBase);
    else weekList[idx].outflow = round2(weekList[idx].outflow + item.amountBase);
  }

  for (const pay of payments) {
    const available = round2(pay.amount_original - (pay.allocated || 0));
    const rate = rateFor(pay.currency, pay.fx_rate, fxRates, baseCurrency);
    // Still list a pre-start payment when its rate is missing: its cash is
    // inside the opening balance, so if it cannot be priced the opening total
    // is silently understated and the item would otherwise be invisible.
    if (pay.received_date < start) {
      if (rate == null) {
        unpriced.push({
          source: 'payment', id: pay.id, kind: pay.kind, ref: pay.ref_no, party: pay.party,
          currency: pay.currency, amountOriginal: round2(pay.amount_original), rate: null,
          amountBase: null, receivedDate: pay.received_date, date: pay.received_date,
          reason: 'missing_rate', beforePlanStart: true,
        });
      }
      continue; // priced pre-start cash is already reflected in the opening balance
    }
    const item = {
      source: 'payment',
      id: pay.id,
      kind: pay.kind,
      ref: pay.ref_no,
      party: pay.party,
      currency: pay.currency,
      amountOriginal: round2(pay.amount_original),
      allocatedOriginal: round2(pay.allocated || 0),
      outstandingOriginal: available,
      rate,
      amountBase: null,
      receivedDate: pay.received_date,
      settlementDate: pay.received_date,
      calendarShiftDays: 0,
      scenarioShiftDays: 0,
      direction: pay.kind === 'receipt' ? 'in' : 'out',
      unallocated: available > 0.005,
      unpriced: rate == null,
    };
    item.key = `pay:${pay.id}`;
    itemsById.set(item.key, item);
    if (rate == null) {
      unpriced.push({ ...item, amountOriginal: available, reason: 'missing_rate' });
      continue;
    }
    item.amountBase = round2(pay.amount_original * rate);
    if (pay.received_date > end) { beyondHorizon.push(item); continue; }
    const idx = weekIndexFor(pay.received_date);
    if (idx < 0) continue;
    weekList[idx].items.push(item);
    if (item.direction === 'in') weekList[idx].inflow = round2(weekList[idx].inflow + item.amountBase);
    else weekList[idx].outflow = round2(weekList[idx].outflow + item.amountBase);
  }

  let running = openingTotal;
  let minBalance = openingTotal;
  let minWeek = null;
  for (const w of weekList) {
    w.opening = running;
    w.net = round2(w.inflow - w.outflow);
    w.closing = round2(running + w.net);
    w.aboveThreshold = round2(w.closing - safetyThreshold) >= 0;
    w.negative = w.closing < 0;
    running = w.closing;
    if (w.closing < minBalance) { minBalance = w.closing; minWeek = w.index; }
    w.items.sort((a, b) => (b.amountBase || 0) - (a.amountBase || 0));
  }

  const totalInflow = round2(weekList.reduce((s, w) => s + w.inflow, 0));
  const totalOutflow = round2(weekList.reduce((s, w) => s + w.outflow, 0));
  const deficitWeeks = weekList.filter((w) => w.closing < 0).length;
  const belowThresholdWeeks = weekList.filter((w) => w.closing < safetyThreshold).length;
  const unpricedByCurrency = {};
  for (const item of unpriced) {
    const bucket = unpricedByCurrency[item.currency] || (unpricedByCurrency[item.currency] = { currency: item.currency, count: 0, totalOriginal: 0 });
    bucket.count += 1;
    bucket.totalOriginal = round2(bucket.totalOriginal + (item.amountOriginal || 0));
  }

  const unapplied = { receipts: { count: 0, totalBase: 0 }, payments: { count: 0, totalBase: 0 } };
  for (const pay of payments) {
    const available = round2(pay.amount_original - (pay.allocated || 0));
    if (available <= 0.005) continue;
    const rate = rateFor(pay.currency, pay.fx_rate, fxRates, baseCurrency);
    if (rate == null) continue;
    const key = pay.kind === 'receipt' ? 'receipts' : 'payments';
    unapplied[key].count += 1;
    unapplied[key].totalBase = round2(unapplied[key].totalBase + available * rate);
  }

  return {
    meta: {
      start,
      end,
      weeks,
      baseCurrency,
      safetyThreshold,
      today,
      scenario: scenario ? { id: scenario.id, name: scenario.name, base: !!scenario.base } : { id: 0, name: '基准方案', base: true },
      calendar: {
        id: calendar.id ?? null,
        name: calendar.name || '',
        weekend_rule: calendar.weekend_rule || 'next',
        weekend_enabled: !!calendar.weekend_enabled,
        holidayCount: holidaySet.size,
      },
      counts: {
        documents: documents.length,
        payments: payments.length,
        forecastItems: weekList.reduce((s, w) => s + w.items.length, 0),
        unpriced: unpriced.length,
        beyondHorizon: beyondHorizon.length,
      },
      generatedAt: new Date().toISOString(),
    },
    summary: {
      openingBalance: openingTotal,
      totalInflow,
      totalOutflow,
      closingBalance: round2(running),
      netChange: round2(totalInflow - totalOutflow),
      minimumBalance: round2(minBalance),
      minimumBalanceWeek: minWeek,
      deficitWeeks,
      belowThresholdWeeks,
      gap: round2(Math.max(0, -minBalance)),
      unpricedCount: unpriced.length,
      unpricedByCurrency: Object.values(unpricedByCurrency),
      overdueCount: documents.filter((d) => d.due_date < today && round2(d.amount_original - (d.allocated || 0)) > 0.005).length,
      overdueAmountBase: round2(
        documents
          .filter((d) => d.due_date < today && round2(d.amount_original - (d.allocated || 0)) > 0.005)
          .reduce((s, d) => {
            const rate = rateFor(d.currency, d.fx_rate, fxRates, baseCurrency);
            return rate == null ? s : s + round2((d.amount_original - (d.allocated || 0)) * rate);
          }, 0),
      ),
      unapplied,
    },
    weeks: weekList,
    openingDetail,
    openingSuperseded,
    unpriced,
    beyondHorizon,
  };
}
