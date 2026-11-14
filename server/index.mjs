import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initSchema } from './db.mjs';
import { seedIfEmpty, isSeeded } from './seed.mjs';
import * as repo from './repo.mjs';
import { isValidISODate, addDays, parseCsv } from './domain.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT || 3000);

initSchema();
if (!isSeeded()) seedIfEmpty();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('请求体过大'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(Object.assign(new Error('请求 JSON 格式无效'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireDate(value, label) {
  if (!isValidISODate(value)) throw repo.httpError(400, `${label}必须是 YYYY-MM-DD`);
  return value;
}

/* ------------------------------------------------------------------ samples */

const SAMPLE_CSV = {
  documents: `类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日,备注
应收,AR-DEMO-01,华东精密机械有限公司,CNY,286000,,${addDays(new Date().toISOString().slice(0, 10), -5)},${addDays(new Date().toISOString().slice(0, 10), 10)},${addDays(new Date().toISOString().slice(0, 10), 14)},部分到账样本
应收,AR-DEMO-02,海外环球贸易有限公司,USD,38000,,${addDays(new Date().toISOString().slice(0, 10), -20)},${addDays(new Date().toISOString().slice(0, 10), 3)},${addDays(new Date().toISOString().slice(0, 10), 6)},缺汇率样本
应付,AP-DEMO-01,宝钢原材料供应有限公司,CNY,415000,,${addDays(new Date().toISOString().slice(0, 10), -8)},${addDays(new Date().toISOString().slice(0, 10), 5)},${addDays(new Date().toISOString().slice(0, 10), 8)},采购样本
`,
  payments: `类型,单号,往来单位,币种,金额,汇率,收付款日期,备注
收款,RC-DEMO-01,华东精密机械有限公司,CNY,120000,,${addDays(new Date().toISOString().slice(0, 10), -2)},部分到账
付款,PM-DEMO-01,宝钢原材料供应有限公司,CNY,90000,,${addDays(new Date().toISOString().slice(0, 10), -1)},部分付款
`,
  opening: `币种,金额,余额日期
CNY,1250000,${new Date().toISOString().slice(0, 10)}
USD,45000,${new Date().toISOString().slice(0, 10)}
`,
};

/* --------------------------------------------------------------- API router */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  if (method === 'GET' && p === '/api/bootstrap') {
    const settings = repo.getSettings();
    return sendJson(res, 200, {
      settings,
      calendars: repo.listCalendars(),
      customers: repo.listCustomers(),
      scenarios: repo.listScenarios(),
      stats: {
        documents: repo.listDocuments({ limit: 1 }).total,
        payments: repo.listPayments().length,
        allocations: repo.listRecentAllocations(1000).length,
      },
    });
  }

  if (method === 'GET' && p === '/api/forecast') {
    const scenarioId = q.get('scenario') ? Number(q.get('scenario')) : 0;
    return sendJson(res, 200, repo.runForecast({ scenarioId }));
  }

  if (method === 'PUT' && p === '/api/settings') {
    const body = await readBody(req);
    if (body.plan_start != null) requireDate(body.plan_start, '计划起始日');
    if (body.plan_weeks != null) {
      const n = Number(body.plan_weeks);
      if (!Number.isInteger(n) || n < 1 || n > 52) throw repo.httpError(400, '计划周数必须是 1–52 的整数');
    }
    if (body.safety_threshold != null && !Number.isFinite(Number(body.safety_threshold))) {
      throw repo.httpError(400, '安全余额阈值必须是数字');
    }
    if (body.fx_rates != null) {
      if (typeof body.fx_rates !== 'object' || Array.isArray(body.fx_rates)) throw repo.httpError(400, '汇率必须是对象');
      const clean = {};
      for (const [ccy, rate] of Object.entries(body.fx_rates)) {
        if (!/^[A-Z]{3}$/.test(ccy)) throw repo.httpError(400, `币种代码无效: ${ccy}`);
        if (rate === '' || rate == null) continue;
        const n = Number(rate);
        if (!Number.isFinite(n) || n <= 0) throw repo.httpError(400, `${ccy} 汇率必须为正数`);
        clean[ccy] = n;
      }
      body.fx_rates = clean;
    }
    if (body.base_currency != null && !/^[A-Z]{3}$/.test(body.base_currency)) {
      throw repo.httpError(400, '本位币代码无效');
    }
    return sendJson(res, 200, { settings: repo.updateSettings(body) });
  }

  if (method === 'PATCH' && p.startsWith('/api/calendars/')) {
    const id = Number(p.split('/')[3]);
    const body = await readBody(req);
    return sendJson(res, 200, { calendar: repo.updateCalendar(id, body) });
  }

  if (method === 'GET' && p === '/api/documents') {
    const kind = q.get('kind') || undefined;
    const search = q.get('q') || undefined;
    const limit = Math.min(Number(q.get('limit')) || 1000, 2000);
    return sendJson(res, 200, repo.listDocuments({ kind, q: search, limit }));
  }

  if (method === 'GET' && /^\/api\/documents\/\d+$/.test(p)) {
    const id = Number(p.split('/')[3]);
    const doc = repo.getDocument(id);
    if (!doc) throw repo.httpError(404, '单据不存在');
    return sendJson(res, 200, {
      document: doc,
      allocations: repo.listAllocationsForDocument(id),
    });
  }

  if (method === 'GET' && p === '/api/payments') {
    const body = {
      rows: repo.listPayments({
        kind: q.get('kind') || undefined,
        onlyUnapplied: q.get('unapplied') === '1',
        q: q.get('q') || undefined,
      }),
    };
    return sendJson(res, 200, body);
  }

  if (method === 'GET' && /^\/api\/payments\/\d+$/.test(p)) {
    const id = Number(p.split('/')[3]);
    const payment = repo.getPayment(id);
    if (!payment) throw repo.httpError(404, '收付款单不存在');
    return sendJson(res, 200, { payment, allocations: repo.listAllocationsForPayment(id) });
  }

  if (method === 'GET' && p === '/api/allocations') {
    return sendJson(res, 200, { rows: repo.listRecentAllocations(200) });
  }

  if (method === 'POST' && p === '/api/allocations') {
    const body = await readBody(req);
    return sendJson(res, 201, { allocation: repo.createAllocation(body) });
  }

  if (method === 'POST' && /^\/api\/allocations\/\d+\/void$/.test(p)) {
    const id = Number(p.split('/')[3]);
    return sendJson(res, 200, { allocation: repo.voidAllocation(id) });
  }

  if (method === 'POST' && /^\/api\/allocations\/\d+\/restore$/.test(p)) {
    const id = Number(p.split('/')[3]);
    return sendJson(res, 200, { allocation: repo.restoreAllocation(id) });
  }

  if (method === 'GET' && p === '/api/unapplied') {
    const rows = repo.listPayments({ onlyUnapplied: true });
    return sendJson(res, 200, {
      receipts: rows.filter((r) => r.kind === 'receipt'),
      payments: rows.filter((r) => r.kind === 'payment'),
    });
  }

  if (method === 'GET' && p === '/api/scenarios') {
    return sendJson(res, 200, { scenarios: repo.listScenarios() });
  }

  if (method === 'POST' && p === '/api/scenarios') {
    const body = await readBody(req);
    return sendJson(res, 201, { scenario: repo.createScenario(body) });
  }

  if (method === 'PATCH' && /^\/api\/scenarios\/\d+$/.test(p)) {
    const id = Number(p.split('/')[3]);
    const body = await readBody(req);
    return sendJson(res, 200, { scenario: repo.updateScenario(id, body) });
  }

  if (method === 'DELETE' && /^\/api\/scenarios\/\d+$/.test(p)) {
    const id = Number(p.split('/')[3]);
    repo.deleteScenario(id);
    return sendJson(res, 200, { ok: true });
  }

  if (method === 'GET' && p === '/api/imports') {
    return sendJson(res, 200, { batches: repo.listImportBatches() });
  }

  if (method === 'POST' && p === '/api/import') {
    const body = await readBody(req);
    const kind = body.kind;
    if (!['documents', 'payments', 'opening'].includes(kind)) throw repo.httpError(400, '导入类型无效');
    if (typeof body.csv !== 'string' || !body.csv.trim()) throw repo.httpError(400, 'CSV 内容为空');
    const result = kind === 'documents'
      ? repo.importDocuments(body.csv, { kindHint: body.kind_hint, filename: body.filename })
      : kind === 'payments'
        ? repo.importPayments(body.csv, { kindHint: body.kind_hint, filename: body.filename })
        : repo.importOpening(body.csv, { filename: body.filename });
    return sendJson(res, 200, result);
  }

  if (method === 'GET' && p.startsWith('/api/sample/')) {
    const kind = p.split('/')[3];
    if (!SAMPLE_CSV[kind]) throw repo.httpError(404, '示例不存在');
    const body = '﻿' + SAMPLE_CSV[kind];
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sample-${kind}.csv"`,
      'Content-Length': Buffer.byteLength(body),
    });
    return res.end(body);
  }

  if (method === 'GET' && p === '/api/audit') {
    const forecast = repo.runForecast({ scenarioId: q.get('scenario') ? Number(q.get('scenario')) : 0 });
    const docs = repo.listDocuments({ limit: 2000 }).rows;
    const pays = repo.listPayments();
    // aggregate every allocation in SQL so the audit can never be weakened by a
    // row LIMIT as the data grows
    const totals = repo.allocationTotals();
    const docAlloc = Object.fromEntries(totals.byDoc.map((r) => [r.id, r.total]));
    const payAlloc = Object.fromEntries(totals.byPay.map((r) => [r.id, r.total]));
    const issues = [];
    for (const d of docs) {
      const a = Math.round((docAlloc[d.id] || 0) * 100) / 100;
      if (a > d.amount_original + 0.005) issues.push(`单据 ${d.doc_no} 核销 ${a} 超过金额 ${d.amount_original}`);
    }
    for (const p2 of pays) {
      const a = Math.round((payAlloc[p2.id] || 0) * 100) / 100;
      if (a > p2.amount_original + 0.005) issues.push(`收付款 ${p2.ref_no} 核销 ${a} 超过金额 ${p2.amount_original}`);
    }
    const sumIn = Math.round(forecast.weeks.reduce((s, w) => s + w.inflow, 0) * 100) / 100;
    const sumOut = Math.round(forecast.weeks.reduce((s, w) => s + w.outflow, 0) * 100) / 100;
    if (Math.abs(sumIn - forecast.summary.totalInflow) > 0.01) issues.push('流入合计与周汇总不一致');
    if (Math.abs(sumOut - forecast.summary.totalOutflow) > 0.01) issues.push('流出合计与周汇总不一致');
    for (const w of forecast.weeks) {
      const items = w.items.reduce((s, it) => s + (it.amountBase || 0), 0);
      if (Math.abs(items - round2(w.inflow + w.outflow)) > 0.02) issues.push(`第 ${w.index + 1} 周明细与合计不一致`);
    }
    return sendJson(res, 200, {
      ok: issues.length === 0,
      issues,
      checks: {
        documents: docs.length,
        payments: pays.length,
        activeAllocations: totals.total - totals.voided,
        voidedAllocations: totals.voided,
        inflow: sumIn,
        outflow: sumOut,
        unpriced: forecast.unpriced.length,
      },
    });
  }

  if (method === 'POST' && p === '/api/reset-demo') {
    seedIfEmpty({ force: true });
    return sendJson(res, 200, { ok: true });
  }

  throw repo.httpError(404, '接口不存在');
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

/* -------------------------------------------------------------- static files */

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400); return res.end('请求路径无效'); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  // compare against the directory plus its separator so a sibling such as
  // /workspace/public-old cannot satisfy a bare prefix match
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403); return res.end('禁止访问');
  }
  fs.stat(full, (err, stat) => {
    if (err || !stat.isFile()) {
      if (!path.extname(rel)) {
        const fallback = path.join(PUBLIC_DIR, 'index.html');
        return fs.readFile(fallback, (e2, data) => {
          if (e2) { res.writeHead(404); return res.end('未找到'); }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data);
        });
      }
      res.writeHead(404); return res.end('未找到');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, url);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || '服务器错误' });
  }
});

server.listen(PORT, () => {
  console.log(`现金计划已启动: http://localhost:${PORT}`);
});

export { server, parseCsv };
