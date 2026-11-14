import { getDb, setSetting, round2 } from './db.mjs';
import { isValidISODate, DOC_ALIASES, PAYMENT_ALIASES, OPENING_ALIASES, parseCsv, mapRow, docImportKey, paymentImportKey, validateAllocation, buildForecast } from './domain.mjs';

const nowISO = () => new Date().toISOString();

/* ------------------------------------------------------------------ settings */

export const DEFAULT_SETTINGS = {
  base_currency: 'CNY',
  safety_threshold: 0,
  plan_start: null,
  plan_weeks: 13,
  fx_rates: { USD: 7.15, EUR: 7.78, HKD: 0.92 },
  fx_plan_name: '2026 年 11 月资金方案',
  company_name: '示例制造有限公司',
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  for (const r of rows) out[r.key] = JSON.parse(r.value);
  return out;
}

export function updateSettings(patch) {
  const allowed = new Set(Object.keys(DEFAULT_SETTINGS));
  for (const [k, v] of Object.entries(patch || {})) {
    if (!allowed.has(k)) continue;
    setSetting(k, v);
  }
  return getSettings();
}

/* ----------------------------------------------------------------- calendars */

export function listCalendars() {
  return getDb().prepare('SELECT * FROM calendars ORDER BY is_default DESC, id').all().map(hydrateCalendar);
}

function hydrateCalendar(row) {
  if (!row) return null;
  let holidays = [];
  try { holidays = JSON.parse(row.holidays); } catch { holidays = []; }
  return { ...row, holidays };
}

export function getCalendar(id) {
  const db = getDb();
  const row = id ? db.prepare('SELECT * FROM calendars WHERE id = ?').get(id) : db.prepare('SELECT * FROM calendars WHERE is_default = 1 ORDER BY id LIMIT 1').get();
  return hydrateCalendar(row);
}

export function updateCalendar(id, patch) {
  const db = getDb();
  const existing = getCalendar(id);
  if (!existing) throw httpError(404, '日历不存在');
  const name = patch.name ?? existing.name;
  const weekend_rule = patch.weekend_rule ?? existing.weekend_rule;
  if (!['none', 'next', 'prev', 'nearest'].includes(weekend_rule)) throw httpError(400, '顺延规则无效');
  const weekend_enabled = patch.weekend_enabled == null ? existing.weekend_enabled : (patch.weekend_enabled ? 1 : 0);
  let holidays = existing.holidays;
  if (patch.holidays != null) {
    if (!Array.isArray(patch.holidays)) throw httpError(400, 'holidays 必须是日期数组');
    const bad = patch.holidays.find((d) => !isValidISODate(d));
    if (bad) throw httpError(400, `假日日期无效: ${bad}`);
    holidays = [...new Set(patch.holidays)].sort();
  }
  db.prepare('UPDATE calendars SET name=?, holidays=?, weekend_rule=?, weekend_enabled=? WHERE id=?')
    .run(name, JSON.stringify(holidays), weekend_rule, weekend_enabled, id);
  // the forecast always reads the default calendar, so "make this one active"
  // must be persisted or the selection would silently change nothing
  if (patch.is_default === true || patch.is_default === 1) {
    db.prepare('UPDATE calendars SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END').run(id);
  }
  return getCalendar(id);
}

/* ----------------------------------------------------------------- customers */

export function listCustomers() {
  return getDb().prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM documents d WHERE d.customer_id = c.id) AS document_count
    FROM customers c ORDER BY c.name
  `).all();
}

/* ------------------------------------------------------ docs & payments read */

export function listDocuments({ kind, q, limit = 500, offset = 0 } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (kind === 'ar' || kind === 'ap') { where.push('d.kind = ?'); params.push(kind); }
  if (q) {
    where.push('(d.doc_no LIKE ? OR d.party LIKE ?)');
    params.push(`%${q}%`, `%${q}%`);
  }
  const sql = `
    SELECT d.*,
      COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.document_id = d.id AND a.voided = 0), 0) AS allocated,
      (SELECT COUNT(*) FROM allocations a WHERE a.document_id = d.id AND a.voided = 0) AS allocation_count
    FROM documents d
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY d.due_date, d.id
    LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM documents d ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`).get(...params).n;
  return { total, rows: rows.map(decorateDoc) };
}

export function decorateDoc(row) {
  const settings = getSettings();
  return {
    ...row,
    allocated: round2(row.allocated || 0),
    outstanding: round2(row.amount_original - (row.allocated || 0)),
    fx_missing: row.currency !== settings.base_currency
      && !(Number(row.fx_rate) > 0)
      && !(Number(settings.fx_rates?.[row.currency]) > 0),
  };
}

export function getDocument(id) {
  const db = getDb();
  const row = db.prepare(`
    SELECT d.*,
      COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.document_id = d.id AND a.voided = 0), 0) AS allocated
    FROM documents d WHERE d.id = ?`).get(id);
  return row ? decorateDoc(row) : null;
}

export function getPayment(id) {
  const db = getDb();
  const row = db.prepare(`
    SELECT p.*,
      COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id AND a.voided = 0), 0) AS allocated
    FROM payments p WHERE p.id = ?`).get(id);
  if (!row) return null;
  return { ...row, allocated: round2(row.allocated || 0), available: round2(row.amount_original - (row.allocated || 0)) };
}

export function listPayments({ kind, onlyUnapplied = false, q } = {}) {
  const db = getDb();
  const where = [];
  const params = [];
  if (kind === 'receipt' || kind === 'payment') { where.push('p.kind = ?'); params.push(kind); }
  if (q) { where.push('(p.ref_no LIKE ? OR p.party LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (onlyUnapplied) {
    where.push('p.amount_original - COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id AND a.voided = 0), 0) > 0.005');
  }  const sql = `
    SELECT p.*,
      COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id AND a.voided = 0), 0) AS allocated,
      (SELECT COUNT(*) FROM allocations a WHERE a.payment_id = p.id AND a.voided = 0) AS allocation_count
    FROM payments p
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY p.received_date DESC, p.id DESC`;
  return db.prepare(sql).all(...params).map((r) => ({
    ...r,
    allocated: round2(r.allocated || 0),
    available: round2(r.amount_original - (r.allocated || 0)),
  }));
}

export function listAllocationsForDocument(docId, { includeVoided = true } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT a.*, p.ref_no, p.kind AS payment_kind, p.party AS payment_party, p.received_date, p.currency AS payment_currency
    FROM allocations a JOIN payments p ON p.id = a.payment_id
    WHERE a.document_id = ? ${includeVoided ? '' : 'AND a.voided = 0'}
    ORDER BY a.voided, a.allocated_date DESC, a.id DESC`).all(docId);
  return rows;
}

export function listAllocationsForPayment(payId, { includeVoided = true } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT a.*, d.doc_no, d.kind AS doc_kind, d.party AS doc_party, d.due_date, d.currency AS doc_currency
    FROM allocations a JOIN documents d ON d.id = a.document_id
    WHERE a.payment_id = ? ${includeVoided ? '' : 'AND a.voided = 0'}
    ORDER BY a.voided, a.allocated_date DESC, a.id DESC`).all(payId);
}

export function listRecentAllocations(limit = 100) {
  return getDb().prepare(`
    SELECT a.*, p.ref_no, p.kind AS payment_kind, p.party AS payment_party,
           d.doc_no, d.kind AS doc_kind, d.party AS doc_party
    FROM allocations a
    JOIN payments p ON p.id = a.payment_id
    JOIN documents d ON d.id = a.document_id
    ORDER BY a.voided, a.created_at DESC, a.id DESC LIMIT ?`).all(limit);
}

/** Allocation totals grouped by document / payment, active (non-voided) only.
 *  Used by the audit so it never depends on a row LIMIT. */
export function allocationTotals() {
  const db = getDb();
  const byDoc = db.prepare(`SELECT document_id AS id, SUM(amount) AS total, COUNT(*) AS n
    FROM allocations WHERE voided = 0 GROUP BY document_id`).all();
  const byPay = db.prepare(`SELECT payment_id AS id, SUM(amount) AS total, COUNT(*) AS n
    FROM allocations WHERE voided = 0 GROUP BY payment_id`).all();
  const counts = db.prepare('SELECT COUNT(*) AS total, SUM(voided) AS voided FROM allocations').get();
  return { byDoc, byPay, total: counts.total || 0, voided: counts.voided || 0 };
}

/* -------------------------------------------------------------- allocations */

export function createAllocation({ payment_id, document_id, amount, allocated_date }) {
  const db = getDb();
  const payment = getPayment(payment_id);
  const document = getDocument(document_id);
  if (!payment || payment.voided) throw httpError(404, '收付款单不存在');
  if (!document) throw httpError(404, '单据不存在');
  const date = allocated_date || new Date().toISOString().slice(0, 10);
  if (!isValidISODate(date)) throw httpError(400, '核销日期无效');

  const err = validateAllocation({
    payment, document, amount,
    activeAllocatedPayment: payment.allocated,
    activeAllocatedDocument: document.allocated,
  });
  if (err) throw httpError(400, err);

  const info = db.prepare('INSERT INTO allocations(payment_id, document_id, amount, allocated_date) VALUES(?,?,?,?)')
    .run(payment_id, document_id, round2(Number(amount)), date);
  return db.prepare('SELECT * FROM allocations WHERE id = ?').get(info.lastInsertRowid);
}

export function voidAllocation(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM allocations WHERE id = ?').get(id);
  if (!row) throw httpError(404, '核销记录不存在');
  if (row.voided) throw httpError(400, '该核销已撤销');
  db.prepare('UPDATE allocations SET voided = 1, voided_at = ? WHERE id = ?').run(nowISO(), id);
  return db.prepare('SELECT * FROM allocations WHERE id = ?').get(id);
}

export function restoreAllocation(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM allocations WHERE id = ?').get(id);
  if (!row) throw httpError(404, '核销记录不存在');
  if (!row.voided) throw httpError(400, '该核销未撤销');
  const payment = getPayment(row.payment_id);
  const document = getDocument(row.document_id);
  const err = validateAllocation({
    payment, document, amount: row.amount,
    activeAllocatedPayment: payment.allocated,
    activeAllocatedDocument: document.allocated,
  });
  if (err) throw httpError(400, `无法恢复：${err}`);
  db.prepare('UPDATE allocations SET voided = 0, voided_at = NULL WHERE id = ?').run(id);
  return db.prepare('SELECT * FROM allocations WHERE id = ?').get(id);
}

/* ------------------------------------------------------------------ opening */

export function listOpeningBalances() {
  return getDb().prepare('SELECT * FROM opening_balances ORDER BY currency').all();
}

/* ----------------------------------------------------------------- scenarios */

export function listScenarios() {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM scenario_overrides o WHERE o.scenario_id = s.id) AS override_count,
      (SELECT COUNT(*) FROM scenario_customer_delays c WHERE c.scenario_id = s.id AND c.delay_days <> 0) AS delay_count
    FROM scenarios s ORDER BY s.base DESC, s.id`).all();
  return rows.map((r) => ({
    ...r,
    base: !!r.base,
    overrides: db.prepare('SELECT * FROM scenario_overrides WHERE scenario_id = ?').all(r.id),
    customer_delays: Object.fromEntries(
      db.prepare('SELECT customer_id, delay_days, reason FROM scenario_customer_delays WHERE scenario_id = ?').all(r.id)
        .map((c) => [c.customer_id, { delay_days: c.delay_days, reason: c.reason }]),
    ),
  }));
}

export function getScenario(id) {
  if (!id || Number(id) === 0) return null;
  return listScenarios().find((s) => s.id === Number(id)) || null;
}

export function createScenario({ name, description, customer_delays = {}, overrides = [] }) {
  if (!name || !String(name).trim()) throw httpError(400, '情景名称不能为空');
  // Validate the assumption payload before the scenario row exists, so a bad
  // customer/document id cannot leave an empty orphan scenario behind.
  const db = getDb();
  for (const custId of Object.keys(customer_delays || {})) {
    if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(custId))) throw httpError(400, `客户 ${custId} 不存在`);
  }
  for (const ov of overrides || []) {
    if (!isValidISODate(ov.expected_date)) throw httpError(400, '情景日期无效');
    if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(Number(ov.document_id))) throw httpError(400, `单据 ${ov.document_id} 不存在`);
  }
  const info = db.prepare('INSERT INTO scenarios(name, description, base) VALUES(?,?,0)')
    .run(String(name).trim(), description || null);
  const id = Number(info.lastInsertRowid);
  try {
    applyScenarioSettings(id, { customer_delays, overrides });
  } catch (err) {
    db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
    throw err;
  }
  return getScenario(id);
}

export function updateScenario(id, { name, description, customer_delays, overrides }) {
  const db = getDb();
  const existing = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  if (!existing) throw httpError(404, '情景不存在');
  if (existing.base) throw httpError(400, '基准方案不能修改');
  if (name != null) db.prepare('UPDATE scenarios SET name=?, description=? WHERE id=?').run(String(name).trim(), description ?? existing.description, id);
  if (customer_delays !== undefined || overrides !== undefined) {
    applyScenarioSettings(id, { customer_delays, overrides });
  }
  return getScenario(id);
}

function applyScenarioSettings(id, { customer_delays, overrides }) {
  const db = getDb();
  // Validate the whole payload BEFORE touching any stored assumption, and write
  // inside one transaction: a rejected edit must not leave a half-applied
  // scenario (previously the old delays/overrides were deleted first, so a bad
  // customer/document id silently wiped the scenario's existing assumptions).
  const delayRows = [];
  if (customer_delays !== undefined) {
    for (const [custId, cfg] of Object.entries(customer_delays || {})) {
      const days = Number(cfg?.delay_days ?? cfg);
      if (!Number.isFinite(days)) throw httpError(400, '延迟天数必须是数字');
      if (!db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(custId))) throw httpError(400, `客户 ${custId} 不存在`);
      delayRows.push([id, Number(custId), Math.trunc(days), cfg?.reason || null]);
    }
  }
  const overrideRows = [];
  if (overrides !== undefined) {
    const seenDocs = new Set();
    for (const ov of overrides || []) {
      if (!isValidISODate(ov.expected_date)) throw httpError(400, '情景日期无效');
      if (!db.prepare('SELECT id FROM documents WHERE id = ?').get(Number(ov.document_id))) throw httpError(400, `单据 ${ov.document_id} 不存在`);
      if (seenDocs.has(Number(ov.document_id))) throw httpError(400, `单据 ${ov.document_id} 重复覆盖`);
      seenDocs.add(Number(ov.document_id));
      overrideRows.push([id, Number(ov.document_id), ov.expected_date, ov.reason || null]);
    }
  }

  db.exec('BEGIN');
  try {
    if (customer_delays !== undefined) {
      db.prepare('DELETE FROM scenario_customer_delays WHERE scenario_id = ?').run(id);
      const ins = db.prepare('INSERT INTO scenario_customer_delays(scenario_id, customer_id, delay_days, reason) VALUES(?,?,?,?)');
      for (const row of delayRows) ins.run(...row);
    }
    if (overrides !== undefined) {
      db.prepare('DELETE FROM scenario_overrides WHERE scenario_id = ?').run(id);
      const ins = db.prepare('INSERT INTO scenario_overrides(scenario_id, document_id, expected_date, reason) VALUES(?,?,?,?)');
      for (const row of overrideRows) ins.run(...row);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteScenario(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM scenarios WHERE id = ?').get(id);
  if (!row) throw httpError(404, '情景不存在');
  if (row.base) throw httpError(400, '基准方案不能删除');
  db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
}

/* ------------------------------------------------------------------ forecast */

export function runForecast({ scenarioId } = {}) {
  const inputs = forecastInputs({ scenarioId });
  const { settings, calendar, scenario, documents, payments, opening } = inputs;
  return buildForecast({
    start: settings.plan_start,
    weeks: settings.plan_weeks,
    documents, payments,
    openingBalances: opening,
    calendar,
    scenario,
    fxRates: settings.fx_rates || {},
    baseCurrency: settings.base_currency,
    safetyThreshold: Number(settings.safety_threshold) || 0,
  });
}

export function forecastInputs({ scenarioId } = {}) {
  const settings = getSettings();
  const calendar = getCalendar();
  if (!calendar) throw httpError(500, '缺少工作日历');
  const scenarios = listScenarios();
  let scenario = null;
  if (scenarioId && Number(scenarioId) !== 0) {
    scenario = scenarios.find((s) => s.id === Number(scenarioId));
    if (!scenario) throw httpError(404, '情景不存在');
  }
  const customerDelays = {};
  for (const [customerId, cfg] of Object.entries(scenario?.customer_delays || {})) {
    customerDelays[Number(customerId)] = cfg;
  }
  const overrides = {};
  for (const ov of scenario?.overrides || []) overrides[ov.document_id] = ov;

  const documents = getDb().prepare(`
    SELECT d.*, COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.document_id = d.id AND a.voided = 0), 0) AS allocated
    FROM documents d`).all();
  const payments = getDb().prepare(`
    SELECT p.*, COALESCE((SELECT SUM(a.amount) FROM allocations a WHERE a.payment_id = p.id AND a.voided = 0), 0) AS allocated
    FROM payments p`).all();
  const opening = listOpeningBalances();

  return {
    settings,
    calendar,
    // preserve the real base flag: requesting the seeded baseline by its id must
    // still behave (and be labelled) as the untouched baseline
    scenario: scenario ? { id: scenario.id, name: scenario.name, base: !!scenario.base, overrides, customer_delays: customerDelays } : null,
    documents, payments, opening,
  };
}

/* ------------------------------------------------------------------ imports */

export function recordImport({ kind, filename, rowsRead, accepted, skipped, rejected, detail }) {
  const db = getDb();
  const id = 'IMP-' + nowISO().replace(/\D/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  db.prepare(`INSERT INTO import_batches(id, kind, filename, rows_read, rows_accepted, rows_skipped, rows_rejected, detail)
              VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, kind, filename || null, rowsRead, accepted, skipped, rejected, JSON.stringify(detail));
  return id;
}

export function importDocuments(csvText, { kindHint, filename } = {}) {
  const parsed = parseCsv(csvText);
  if (parsed.error) throw httpError(400, parsed.error);
  const db = getDb();
  const settings = getSettings();
  const customers = listCustomers();
  const batch = 'B' + Date.now().toString(36).toUpperCase();
  const accepted = []; const skipped = []; const rejected = [];

  parsed.rows.forEach((row, i) => {
    const rec = mapRow(parsed.headers, row.values, DOC_ALIASES);
    const warnings = [];
    const kind = (rec.kind || kindHint || '').toLowerCase();
    const normalizedKind = ['ar', '应收', 'receivable'].includes(kind) ? 'ar'
      : ['ap', '应付', 'payable'].includes(kind) ? 'ap' : null;
    if (!normalizedKind) return rejected.push({ line: row.line, reason: '类型必须为 ar/应收 或 ap/应付', raw: row.values });
    if (!rec.doc_no) return rejected.push({ line: row.line, reason: '缺少单据号', raw: row.values });
    if (!rec.party) return rejected.push({ line: row.line, reason: '缺少往来单位', raw: row.values });
    const amount = Number(rec.amount);
    if (!Number.isFinite(amount) || amount <= 0) return rejected.push({ line: row.line, reason: '金额必须为正数', raw: row.values });
    const currency = (rec.currency || settings.base_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return rejected.push({ line: row.line, reason: `币种无效: ${rec.currency}`, raw: row.values });
    if (!isValidISODate(rec.due_date)) return rejected.push({ line: row.line, reason: `到期日无效: ${rec.due_date}`, raw: row.values });
    const expected = rec.expected_date || rec.due_date;
    if (!isValidISODate(expected)) return rejected.push({ line: row.line, reason: `预计结算日无效: ${rec.expected_date}`, raw: row.values });
    if (!isValidISODate(rec.issue_date || rec.due_date)) return rejected.push({ line: row.line, reason: `开票日期无效: ${rec.issue_date}`, raw: row.values });
    let fx = rec.fx_rate === '' || rec.fx_rate == null ? null : Number(rec.fx_rate);
    if (fx != null && (!Number.isFinite(fx) || fx <= 0)) return rejected.push({ line: row.line, reason: `汇率无效: ${rec.fx_rate}`, raw: row.values });
    // Never persist the plan rate as if it were an explicit document rate: leaving
    // fx_rate blank keeps the row following the plan, so later rate edits in
    // Settings still flow through to the forecast.
    if (currency !== settings.base_currency && fx == null) {
      warnings.push(settings.fx_rates?.[currency] ? '未填汇率，将按本次方案汇率换算' : '汇率缺失，将单独列示');
    }
    const key = docImportKey({ kind: normalizedKind, doc_no: rec.doc_no, party: rec.party, currency, amount, due_date: rec.due_date });
    const exists = db.prepare('SELECT id FROM documents WHERE import_key = ?').get(key);
    if (exists) return skipped.push({ line: row.line, reason: '重复导入，已跳过', ref: rec.doc_no, id: exists.id });

    const cust = customers.find((c) => c.name === rec.party);
    try {
      const info = db.prepare(`INSERT INTO documents(kind, doc_no, party, customer_id, currency, amount_original, fx_rate,
        issue_date, due_date, expected_date, note, import_batch, import_key)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        normalizedKind, String(rec.doc_no).trim(), String(rec.party).trim(), cust?.id ?? null, currency, round2(amount), fx,
        rec.issue_date || rec.due_date, rec.due_date, expected, rec.note || null, batch, key,
      );
      accepted.push({ line: row.line, id: Number(info.lastInsertRowid), ref: rec.doc_no, warnings });
    } catch (e) {
      rejected.push({ line: row.line, reason: e.message, raw: row.values });
    }
  });

  const id = recordImport({
    kind: 'documents', filename,
    rowsRead: parsed.rows.length, accepted: accepted.length, skipped: skipped.length, rejected: rejected.length,
    detail: { accepted, skipped, rejected },
  });
  return { batch: id, rowsRead: parsed.rows.length, accepted, skipped, rejected };
}

export function importPayments(csvText, { kindHint, filename } = {}) {
  const parsed = parseCsv(csvText);
  if (parsed.error) throw httpError(400, parsed.error);
  const db = getDb();
  const settings = getSettings();
  const batch = 'B' + Date.now().toString(36).toUpperCase();
  const accepted = []; const skipped = []; const rejected = [];

  parsed.rows.forEach((row) => {
    const rec = mapRow(parsed.headers, row.values, PAYMENT_ALIASES);
    const warnings = [];
    const kind = (rec.kind || kindHint || '').toLowerCase();
    const normalizedKind = ['receipt', '收款', '已收'].includes(kind) ? 'receipt'
      : ['payment', '付款', '已付'].includes(kind) ? 'payment' : null;
    if (!normalizedKind) return rejected.push({ line: row.line, reason: '类型必须为 receipt/收款 或 payment/付款', raw: row.values });
    if (!rec.ref_no) return rejected.push({ line: row.line, reason: '缺少收付款单号', raw: row.values });
    if (!rec.party) return rejected.push({ line: row.line, reason: '缺少往来单位', raw: row.values });
    const amount = Number(rec.amount);
    if (!Number.isFinite(amount) || amount <= 0) return rejected.push({ line: row.line, reason: '金额必须为正数', raw: row.values });
    const currency = (rec.currency || settings.base_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return rejected.push({ line: row.line, reason: `币种无效: ${rec.currency}`, raw: row.values });
    if (!isValidISODate(rec.received_date)) return rejected.push({ line: row.line, reason: `收付款日期无效: ${rec.received_date}`, raw: row.values });
    let fx = rec.fx_rate === '' || rec.fx_rate == null ? null : Number(rec.fx_rate);
    if (fx != null && (!Number.isFinite(fx) || fx <= 0)) return rejected.push({ line: row.line, reason: `汇率无效: ${rec.fx_rate}`, raw: row.values });
    if (currency !== settings.base_currency && fx == null) {
      warnings.push(settings.fx_rates?.[currency] ? '未填汇率，将按本次方案汇率换算' : '汇率缺失，将单独列示');
    }
    const key = paymentImportKey({ kind: normalizedKind, ref_no: rec.ref_no, party: rec.party, currency, amount, received_date: rec.received_date });
    const exists = db.prepare('SELECT id FROM payments WHERE import_key = ?').get(key);
    if (exists) return skipped.push({ line: row.line, reason: '重复导入，已跳过', ref: rec.ref_no, id: exists.id });
    try {
      const info = db.prepare(`INSERT INTO payments(kind, ref_no, party, currency, amount_original, fx_rate, received_date, note, import_batch, import_key)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
        normalizedKind, String(rec.ref_no).trim(), String(rec.party).trim(), currency, round2(amount), fx,
        rec.received_date, rec.note || null, batch, key,
      );
      accepted.push({ line: row.line, id: Number(info.lastInsertRowid), ref: rec.ref_no, warnings });
    } catch (e) {
      rejected.push({ line: row.line, reason: e.message, raw: row.values });
    }
  });

  const id = recordImport({
    kind: 'payments', filename,
    rowsRead: parsed.rows.length, accepted: accepted.length, skipped: skipped.length, rejected: rejected.length,
    detail: { accepted, skipped, rejected },
  });
  return { batch: id, rowsRead: parsed.rows.length, accepted, skipped, rejected };
}

export function importOpening(csvText, { filename } = {}) {
  const parsed = parseCsv(csvText);
  if (parsed.error) throw httpError(400, parsed.error);
  const db = getDb();
  const settings = getSettings();
  const accepted = []; const skipped = []; const rejected = [];

  parsed.rows.forEach((row) => {
    const rec = mapRow(parsed.headers, row.values, OPENING_ALIASES);
    const currency = (rec.currency || settings.base_currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) return rejected.push({ line: row.line, reason: `币种无效: ${rec.currency}`, raw: row.values });
    const amount = Number(rec.amount);
    if (!Number.isFinite(amount)) return rejected.push({ line: row.line, reason: '金额必须是数字', raw: row.values });
    const asOf = rec.as_of || settings.plan_start || new Date().toISOString().slice(0, 10);
    if (!isValidISODate(asOf)) return rejected.push({ line: row.line, reason: `余额日期无效: ${rec.as_of}`, raw: row.values });
    const existing = db.prepare('SELECT * FROM opening_balances WHERE currency = ? AND as_of = ?').get(currency, asOf);    if (existing && Math.abs(existing.amount - round2(amount)) < 0.005) {
      return skipped.push({ line: row.line, reason: '重复导入，金额未变化', currency });
    }
    // Store null so the row always resolves its rate against the CURRENT plan:
    // a literal 1 would silently become "1 CNY = 1 USD" if the base currency
    // is later switched, instead of surfacing as a missing rate.
    const rate = null;
    if (existing) {
      db.prepare('UPDATE opening_balances SET amount = ?, fx_rate = ? WHERE id = ?').run(round2(amount), rate, existing.id);
      accepted.push({ line: row.line, id: existing.id, currency, amount: round2(amount), updated: true });
    } else {
      const info = db.prepare('INSERT INTO opening_balances(currency, amount, as_of, fx_rate) VALUES(?,?,?,?)')
        .run(currency, round2(amount), asOf, rate);
      accepted.push({ line: row.line, id: Number(info.lastInsertRowid), currency, amount: round2(amount) });
    }
  });

  const id = recordImport({
    kind: 'opening', filename,
    rowsRead: parsed.rows.length, accepted: accepted.length, skipped: skipped.length, rejected: rejected.length,
    detail: { accepted, skipped, rejected },
  });
  return { batch: id, rowsRead: parsed.rows.length, accepted, skipped, rejected };
}

export function listImportBatches(limit = 50) {
  return getDb().prepare('SELECT * FROM import_batches ORDER BY created_at DESC, id DESC LIMIT ?').all(limit)
    .map((b) => ({ ...b, detail: safeJson(b.detail, {}) }));
}

function safeJson(text, fallback) { try { return JSON.parse(text); } catch { return fallback; } }

/* -------------------------------------------------------------------- errors */

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
