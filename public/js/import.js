import { $, $$, state, escapeHtml, toast, api } from './base.js';

const KIND_META = {
  documents: {
    label: '应收应付单据', hint: '支持 UTF-8、逗号分隔，首行为表头。重复单据号+金额+到期日将自动跳过。',
    template: '/api/sample/documents',
    placeholder: '类型,单据号,往来单位,币种,金额,汇率,开票日期,到期日,预计结算日,备注',
    hasHint: true,
  },
  payments: {
    label: '已收已付款', hint: '类型填“收款/付款”。导入后进入未分配池，可再核销到单据。',
    template: '/api/sample/payments',
    placeholder: '类型,单号,往来单位,币种,金额,汇率,收付款日期,备注',
    hasHint: true,
  },
  opening: {
    label: '期初余额', hint: '同一币种+余额日期重复导入时，金额相同跳过、金额不同更新。',
    template: '/api/sample/opening',
    placeholder: '币种,金额,余额日期',
    hasHint: false,
  },
};

export function initImportView() {
  $$('#importKindFilter button').forEach((b) => b.addEventListener('click', () => {
    $$('#importKindFilter button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.importKind = b.dataset.kind;
    applyKindMeta();
  }));
  $('#pickFileBtn').addEventListener('click', () => $('#fileInput').click());
  $('#fileInput').addEventListener('change', (e) => handleFile(e.target.files[0]));
  $('#importDrop').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    $('#fileInput').click();
  });
  const drop = $('#importDrop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('dragover'); }));
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });
  $('#loadSampleBtn').addEventListener('click', async () => {
    try {
      const res = await fetch(KIND_META[state.importKind].template);
      const text = await res.text();
      $('#csvInput').value = text.replace(/^﻿/, '');
      updateCsvStats();
      toast('已加载示例内容，点击“开始导入”');
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#csvInput').addEventListener('input', updateCsvStats);
  $('#importBtn').addEventListener('click', runImport);
  applyKindMeta();
}

function applyKindMeta() {
  const meta = KIND_META[state.importKind];
  $('#importHint').textContent = meta.hint;
  $('#downloadSample').href = meta.template;
  $('#csvInput').placeholder = meta.placeholder;
  $('#importOptions').hidden = !meta.hasHint;
  $('#csvInput').value = '';
  $('#importResult').innerHTML = '';
  updateCsvStats();
}

function updateCsvStats() {
  const text = $('#csvInput').value.replace(/^﻿/, '').trim();
  if (!text) { $('#csvStats').textContent = ''; return; }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  $('#csvStats').textContent = `${lines.length} 行（含表头），${(text.length / 1024).toFixed(1)} KB`;
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type !== 'text/csv') {
    toast('请选择 .csv 文件', 'err');
    return;
  }
  const text = await file.text();
  $('#csvInput').value = text.replace(/^﻿/, '');
  updateCsvStats();
  toast(`已读取 ${file.name}`);
}

async function runImport() {
  const csv = $('#csvInput').value.trim();
  if (!csv) return toast('请粘贴 CSV 内容或选择文件', 'err');
  const btn = $('#importBtn');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const body = {
      kind: state.importKind,
      csv,
      kind_hint: $('#importKindHint').value || undefined,
      filename: 'manual-paste.csv',
    };
    const result = await api('/api/import', { method: 'POST', body });
    renderImportResult(result);
    toast(`导入完成：新增 ${result.accepted.length} 行`);
    await window.cashplan?.refreshAll?.();
    loadImports();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = '开始导入';
  }
}

function renderImportResult(result) {
  const { accepted, skipped, rejected } = result;
  const rows = [
    ...accepted.map((r) => ({ type: 'ok', line: r.line, text: `第 ${r.line} 行 · ${r.ref || r.currency || ''} 已导入${r.warnings?.length ? '（' + r.warnings.join('；') + '）' : ''}` })),
    ...skipped.map((r) => ({ type: 'skip', line: r.line, text: `第 ${r.line} 行 · ${r.ref || r.currency || ''} ${r.reason}` })),
    ...rejected.map((r) => ({ type: 'bad', line: r.line, text: `第 ${r.line} 行 · ${r.reason}` })),
  ].sort((a, b) => a.line - b.line);

  $('#importResult').innerHTML = `
    <div class="result-cards">
      <div class="result-card good"><div class="rv">${accepted.length}</div><div class="rl">新增 / 更新</div></div>
      <div class="result-card skip"><div class="rv">${skipped.length}</div><div class="rl">跳过（重复）</div></div>
      <div class="result-card bad"><div class="rv">${rejected.length}</div><div class="rl">拒绝</div></div>
      <div class="result-card"><div class="rv">${result.rowsRead}</div><div class="rl">读取行数</div></div>
    </div>
    <div class="import-detail">
      <div class="check-list">${rows.length ? rows.map((r) => `
        <div class="check-item"><span class="check-dot ${r.type === 'ok' ? 'ok' : r.type === 'bad' ? 'bad' : ''}" style="${r.type === 'skip' ? 'background:var(--text-muted)' : ''}"></span>
        <span>${escapeHtml(r.text)}</span></div>`).join('') : '<div class="empty">没有数据行</div>'}</div>
    </div>`;
}

export async function loadImports() {
  try {
    const { batches } = await api('/api/imports');
    state.importBatches = batches;
    renderImportHistory(batches);
  } catch (err) { toast(err.message, 'err'); }
}

function renderImportHistory(batches) {
  const host = $('#importHistory');
  if (!batches.length) { host.innerHTML = `<div class="empty"><strong>尚无导入记录</strong>导入结果会保存在这里供核对</div>`; return; }
  host.innerHTML = `<div class="table-wrap"><table class="data">
    <thead><tr><th>批次</th><th>类型</th><th>文件</th><th class="num">读取</th><th class="num">新增</th><th class="num">跳过</th><th class="num">拒绝</th><th>时间</th><th></th></tr></thead>
    <tbody>${batches.map((b) => `
      <tr>
        <td class="mono">${escapeHtml(b.id)}</td>
        <td><span class="tag neutral">${kindLabel(b.kind)}</span></td>
        <td>${escapeHtml(b.filename || '—')}</td>
        <td class="num">${b.rows_read}</td>
        <td class="num" style="color:var(--good-text)">${b.rows_accepted}</td>
        <td class="num muted">${b.rows_skipped}</td>
        <td class="num" style="color:${b.rows_rejected ? 'var(--critical-text)' : 'inherit'}">${b.rows_rejected}</td>
        <td class="muted">${escapeHtml((b.created_at || '').replace('T', ' ').slice(0, 16))}</td>
        <td class="num"><button class="btn xs ghost" data-batch="${escapeHtml(b.id)}">详情</button></td>
      </tr>`).join('')}
    </tbody></table></div>`;
  $$('#importHistory [data-batch]').forEach((btn) => btn.addEventListener('click', () => {
    const b = batches.find((x) => x.id === btn.dataset.batch);
    renderImportResult({
      accepted: b.detail?.accepted || [],
      skipped: b.detail?.skipped || [],
      rejected: b.detail?.rejected || [],
      rowsRead: b.rows_read,
    });
    $('#importResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }));
}

function kindLabel(kind) {
  return { documents: '应收应付', payments: '收付款', opening: '期初余额' }[kind] || kind;
}
