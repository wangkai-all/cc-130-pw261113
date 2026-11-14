import { $, $$, state, fmt, escapeHtml, toast, api } from './base.js';

let editorState = null;

export async function loadScenarios() {
  try {
    const [{ scenarios }, overview] = await Promise.all([
      api('/api/scenarios'),
      loadCompareData(),
    ]);
    state.scenarios = scenarios;
    state.scenarioCompare = overview;
    renderScenarioList(scenarios);
    renderScenarioCompare(overview);
    if (!editorState) startNewScenario();
  } catch (err) { toast(err.message, 'err'); }
}

async function loadCompareData() {
  const list = [];
  const scenarios = (await api('/api/scenarios')).scenarios;
  for (const s of scenarios) {
    const f = await api(`/api/forecast?scenario=${s.base ? 0 : s.id}`);
    list.push({
      id: s.base ? 0 : s.id,
      name: s.name,
      base: s.base,
      minBalance: f.summary.minimumBalance,
      minimumWeek: f.summary.minimumBalanceWeek,
      gap: f.summary.gap,
      deficitWeeks: f.summary.deficitWeeks,
      belowThresholdWeeks: f.summary.belowThresholdWeeks,
      closing: f.summary.closingBalance,
      weekly: f.weeks.map((w) => w.closing),
      meta: f.meta,
    });
  }
  return list;
}

function renderScenarioCompare(list) {
  const base = list.find((s) => s.base);
  const host = $('#scenarioCompare');
  if (!list.length) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="panel"><div class="panel-head"><div><h2>情景对照</h2><p class="muted">最低周末余额与基准方案的差异；原始单据始终不变。</p></div></div>
    <div class="compare-grid">${list.map((s) => {
      const delta = s.minBalance - (base?.minBalance ?? 0);
      const cls = s.id === state.scenarioId ? 'current' : s.base ? 'base' : '';
      const maxAbs = Math.max(1, ...s.weekly.map((v) => Math.abs(v)));
      return `<div class="compare-card ${cls}">
        <div class="cc-name">${escapeHtml(s.name)} ${s.base ? '<span class="tag neutral">基准</span>' : delta < 0 ? '<span class="tag risk">缺口扩大</span>' : delta > 0 ? '<span class="tag ok">改善</span>' : ''}</div>
        <div class="cc-value" style="color:${s.minBalance < 0 ? 'var(--critical-text)' : 'inherit'}">${fmt.base(s.minBalance)}</div>
        <div class="cc-delta ${delta < 0 ? 'delta-bad' : delta > 0 ? 'delta-good' : 'delta-flat'}">
          最低余额${delta === 0 ? '与基准持平' : `较基准 ${delta > 0 ? '+' : '−'}${fmt.base(Math.abs(delta))}`}
        </div>
        <div class="cc-delta delta-flat" style="margin-top:2px">缺口周 ${s.deficitWeeks} · 低于安全线 ${s.belowThresholdWeeks} 周</div>
        <div class="mini-bars" aria-hidden="true">${s.weekly.map((v) => `<div class="mini-bar ${v < 0 ? 'neg' : ''}" style="height:${(Math.abs(v) / maxAbs * 100).toFixed(1)}%" title="${fmt.base(v)}"></div>`).join('')}</div>
      </div>`;
    }).join('')}</div>
    <p class="hint" style="margin-top:10px">点击左侧情景查看或编辑；在顶部“查看”下拉框切换预测所用的情景。</p></div>`;
}

function renderScenarioList(scenarios) {
  const host = $('#scenarioList');
  host.innerHTML = scenarios.map((s) => `
    <div class="scenario-list-item ${s.id === (editorState?.id ?? null) ? 'active' : ''}" data-scenario="${s.id}">
      <div class="title"><span>${escapeHtml(s.name)}</span>${s.base ? '<span class="tag neutral">基准</span>' : ''}</div>
      <div class="meta">
        ${s.base ? '<span>原始单据</span>' : `<span>${s.override_count} 张单据覆盖</span><span>${s.delay_count} 个客户延迟</span>`}
      </div>
      ${s.description ? `<div class="meta"><span>${escapeHtml(s.description)}</span></div>` : ''}
    </div>`).join('') + `<button class="btn ghost sm" id="scenarioListNew" style="width:100%;justify-content:center;margin-top:6px">+ 新建情景</button>`;

  $$('#scenarioList [data-scenario]').forEach((el) => el.addEventListener('click', () => {
    const id = Number(el.dataset.scenario);
    const s = scenarios.find((x) => x.id === id);
    if (s.base) { toast('基准方案不可编辑，请新建情景'); return; }
    editorState = {
      id: s.id,
      name: s.name,
      description: s.description || '',
      customer_delays: JSON.parse(JSON.stringify(s.customer_delays || {})),
      overrides: s.overrides.map((o) => ({ document_id: o.document_id, expected_date: o.expected_date, reason: o.reason || '' })),
      base: false,
    };
    renderScenarioList(scenarios);
    renderScenarioEditor();
  }));
  $('#scenarioListNew')?.addEventListener('click', startNewScenario);
}

export function startNewScenario() {
  editorState = { id: null, name: '', description: '', customer_delays: {}, overrides: [], base: false };
  renderScenarioEditor();
  $$('#scenarioList [data-scenario]').forEach((el) => el.classList.remove('active'));
}

function renderScenarioEditor() {
  const host = $('#scenarioEditor');
  if (!editorState) return;
  const isNew = !editorState.id;
  $('#scenarioEditorTitle').textContent = isNew ? '新建情景' : `编辑：${editorState.name}`;

  const customers = state.customers.filter((c) => /^C-/.test(c.code));
  host.innerHTML = `
    <div class="form-grid">
      <label class="field"><span>情景名称</span><input id="scName" value="${escapeHtml(editorState.name)}" placeholder="如：大客户延迟 45 天" /></label>
      <label class="field"><span>说明（可选）</span><input id="scDesc" value="${escapeHtml(editorState.description)}" placeholder="情景假设" /></label>
    </div>
    <div class="section-card" style="margin-top:12px">
      <h3>按客户调整预计回款日期</h3>
      <p class="hint" style="margin-bottom:8px">延迟天数会加到该客户所有应收单据的预计结算日上；只影响情景，不改写原始单据。</p>
      ${customers.map((c) => {
        const cfg = editorState.customer_delays[c.id] || editorState.customer_delays[String(c.id)] || {};
        const days = cfg.delay_days ?? '';
        return `<div class="delay-row">
          <div class="cust">${escapeHtml(c.name)}${c.delay_days ? `<span class="muted" style="font-weight:400"> · 历史平均延迟 ${c.delay_days} 天</span>` : ''}</div>
          <input class="mini-input" type="number" step="1" data-delay-customer="${c.id}" value="${days}" placeholder="0" />
          <input class="mini-input" data-delay-reason="${c.id}" value="${escapeHtml(cfg.reason || '')}" placeholder="原因（可选）" />
          <span class="muted">天</span>
        </div>`;
      }).join('')}
    </div>
    <div class="section-card">
      <h3>单张单据覆盖</h3>
      <p class="hint">优先级高于客户延迟；用于重点单据的单独假设。</p>
      <div id="overrideList">${renderOverrides()}</div>
      <button class="btn ghost sm" id="addOverride" style="margin-top:8px">+ 添加单据覆盖</button>
    </div>
    <div class="btn-row" style="justify-content:space-between;margin-top:14px">
      <div class="btn-row">
        <button class="btn primary" id="saveScenario">${isNew ? '创建情景' : '保存修改'}</button>
        ${!isNew ? '<button class="btn danger" id="deleteScenario">删除情景</button>' : '<button class="btn ghost" id="cancelScenario">取消</button>'}
      </div>
      ${!isNew ? '<button class="btn ghost" id="applyScenario">在预测中查看此情景</button>' : ''}
    </div>`;
  bindEditor();
}

function renderOverrides() {
  const docs = state.forecast?.weeks.flatMap((w) => w.items).filter((it) => it.source === 'document') || [];
  const uniq = [];
  const seen = new Set();
  for (const d of docs) { if (!seen.has(d.id)) { seen.add(d.id); uniq.push(d); } }
  // add from existing overrides not in current horizon
  for (const o of editorState.overrides) {
    if (!seen.has(o.document_id)) {
      uniq.push({ id: o.document_id, ref: `#${o.document_id}`, party: '(超出当前周范围)', kind: 'ar' });
    }
  }
  if (!editorState.overrides.length) return `<div class="empty" style="padding:14px">暂无单据覆盖</div>`;
  return editorState.overrides.map((o, i) => {
    return `<div class="delay-row" style="grid-template-columns:1fr 130px 1fr 30px">
      <select data-ov-doc="${i}" class="mini-input">
        ${uniq.map((x) => `<option value="${x.id}" ${x.id === o.document_id ? 'selected' : ''}>${escapeHtml(x.ref)} · ${escapeHtml(x.party)}</option>`).join('')}
      </select>
      <input type="date" class="mini-input" data-ov-date="${i}" value="${o.expected_date}" />
      <input class="mini-input" data-ov-reason="${i}" value="${escapeHtml(o.reason || '')}" placeholder="原因" />
      <button class="btn xs ghost" data-ov-remove="${i}" title="删除">✕</button>
    </div>`;
  }).join('');
}

function bindEditor() {
  $('#scName').addEventListener('input', (e) => { editorState.name = e.target.value; });
  $('#scDesc').addEventListener('input', (e) => { editorState.description = e.target.value; });
  $$('[data-delay-customer]').forEach((inp) => inp.addEventListener('input', () => {
    const id = inp.dataset.delayCustomer;
    const days = Number(inp.value) || 0;
    const reason = $(`[data-delay-reason="${id}"]`)?.value || '';
    if (!days && !reason) delete editorState.customer_delays[id];
    else editorState.customer_delays[id] = { delay_days: days, reason };
  }));
  $$('[data-delay-reason]').forEach((inp) => inp.addEventListener('input', () => {
    const id = inp.dataset.delayReason;
    const days = Number($(`[data-delay-customer="${id}"]`)?.value) || 0;
    if (!days && !inp.value) delete editorState.customer_delays[id];
    else editorState.customer_delays[id] = { delay_days: days, reason: inp.value };
  }));
  $$('[data-ov-doc]').forEach((sel) => sel.addEventListener('change', () => {
    editorState.overrides[Number(sel.dataset.ovDoc)].document_id = Number(sel.value);
  }));
  $$('[data-ov-date]').forEach((inp) => inp.addEventListener('change', () => {
    editorState.overrides[Number(inp.dataset.ovDate)].expected_date = inp.value;
  }));
  $$('[data-ov-reason]').forEach((inp) => inp.addEventListener('input', () => {
    editorState.overrides[Number(inp.dataset.ovReason)].reason = inp.value;
  }));
  $$('[data-ov-remove]').forEach((b) => b.addEventListener('click', () => {
    editorState.overrides.splice(Number(b.dataset.ovRemove), 1);
    $('#overrideList').innerHTML = renderOverrides();
    bindOverrideEvents();
  }));
  $('#addOverride').addEventListener('click', () => {
    const d = state.forecast?.weeks.flatMap((w) => w.items).find((it) => it.source === 'document');
    if (!d) return toast('当前没有可覆盖的单据', 'err');
    editorState.overrides.push({ document_id: d.id, expected_date: d.expectedDate, reason: '' });
    $('#overrideList').innerHTML = renderOverrides();
    bindOverrideEvents();
  });
  $('#saveScenario').addEventListener('click', saveScenario);
  $('#deleteScenario')?.addEventListener('click', deleteScenario);
  $('#applyScenario')?.addEventListener('click', () => {
    state.scenarioId = editorState.id;
    $('#scenarioSelect').value = String(editorState.id);
    window.cashplan?.switchView?.('forecast');
    window.cashplan?.loadForecast?.();
  });
  $('#cancelScenario')?.addEventListener('click', startNewScenario);
}

function bindOverrideEvents() {
  $$('[data-ov-doc]').forEach((sel) => sel.addEventListener('change', () => {
    editorState.overrides[Number(sel.dataset.ovDoc)].document_id = Number(sel.value);
  }));
  $$('[data-ov-date]').forEach((inp) => inp.addEventListener('change', () => {
    editorState.overrides[Number(inp.dataset.ovDate)].expected_date = inp.value;
  }));
  $$('[data-ov-reason]').forEach((inp) => inp.addEventListener('input', () => {
    editorState.overrides[Number(inp.dataset.ovReason)].reason = inp.value;
  }));
  $$('[data-ov-remove]').forEach((b) => b.addEventListener('click', () => {
    editorState.overrides.splice(Number(b.dataset.ovRemove), 1);
    $('#overrideList').innerHTML = renderOverrides();
    bindOverrideEvents();
  }));
}

async function saveScenario() {
  if (!editorState.name.trim()) return toast('请填写情景名称', 'err');
  const payload = {
    name: editorState.name.trim(),
    description: editorState.description.trim(),
    customer_delays: editorState.customer_delays,
    overrides: editorState.overrides.filter((o) => o.document_id && o.expected_date),
  };
  try {
    if (editorState.id) await api(`/api/scenarios/${editorState.id}`, { method: 'PATCH', body: payload });
    else await api('/api/scenarios', { method: 'POST', body: payload });
    toast(editorState.id ? '情景已保存' : '情景已创建');
    editorState = null;
    await window.cashplan?.loadBootstrap?.();
    await loadScenarios();
  } catch (err) { toast(err.message, 'err'); }
}

async function deleteScenario() {
  if (!confirm('删除该情景？仅删除情景假设，原始单据不受影响。')) return;
  try {
    await api(`/api/scenarios/${editorState.id}`, { method: 'DELETE' });
    toast('情景已删除');
    if (state.scenarioId === editorState.id) { state.scenarioId = 0; $('#scenarioSelect').value = '0'; }
    editorState = null;
    await window.cashplan?.loadBootstrap?.();
    await loadScenarios();
    await window.cashplan?.loadForecast?.();
  } catch (err) { toast(err.message, 'err'); }
}

export function initScenariosView() {
  $('#newScenarioBtn').addEventListener('click', startNewScenario);
}
