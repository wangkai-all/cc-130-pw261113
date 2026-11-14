import { $, $$, state, fmt, escapeHtml, toast, api } from './base.js';

export function renderSettings() {
  const s = state.settings;
  if (!s) return;
  renderPlan(s);
  renderCalendar();
  renderFx(s);
}

function renderPlan(s) {
  $('#planSettings').innerHTML = `
    <div class="form-grid">
      <label class="field"><span>公司名称</span><input id="setCompany" value="${escapeHtml(s.company_name || '')}" /></label>
      <label class="field"><span>本位币</span><input id="setBase" value="${escapeHtml(s.base_currency)}" maxlength="3" style="text-transform:uppercase" /></label>
      <label class="field"><span>计划起始日</span><input id="setStart" type="date" value="${s.plan_start || ''}" /></label>
      <label class="field"><span>计划周数</span><input id="setWeeks" type="number" min="1" max="52" value="${s.plan_weeks}" /></label>
      <label class="field"><span>安全余额阈值（本位币）</span><input id="setThreshold" type="number" step="1000" value="${s.safety_threshold}" /></label>
      <label class="field"><span>汇率方案名称</span><input id="setFxName" value="${escapeHtml(s.fx_plan_name || '')}" /></label>
    </div>
    <div class="btn-row" style="margin-top:12px"><button class="btn primary sm" id="savePlan">保存计划参数</button></div>
    <p class="hint" style="margin-top:8px">账面到期日用于逾期判断；预计结算日用于预测排期，二者互不覆盖。</p>
    ${Object.keys(s.fx_rates || {}).includes(s.base_currency) ? `<p class="hint" style="color:color-mix(in srgb, var(--warning) 62%, var(--text-primary))">当前汇率方案里含有本位币 ${s.base_currency} 的汇率。本位币无需汇率，保留该条只会在切换本位币后被误用，建议在下方汇率设置中清空。</p>` : ''}`;

  $('#savePlan').addEventListener('click', async () => {
    const patch = {
      company_name: $('#setCompany').value.trim(),
      base_currency: $('#setBase').value.trim().toUpperCase(),
      plan_start: $('#setStart').value,
      plan_weeks: Number($('#setWeeks').value),
      safety_threshold: Number($('#setThreshold').value),
      fx_plan_name: $('#setFxName').value.trim(),
    };
    try {
      const { settings } = await api('/api/settings', { method: 'PUT', body: patch });
      state.settings = settings;
      toast('计划参数已保存');
      await window.cashplan?.loadBootstrap?.();
      await window.cashplan?.loadForecast?.();
      renderSettings();
    } catch (err) { toast(err.message, 'err'); }
  });
}

function renderCalendar() {
  const cal = state.calendars.find((c) => c.is_default) || state.calendars[0];
  if (!cal) { $('#calendarSettings').innerHTML = '<div class="empty">缺少日历</div>'; return; }
  state.activeCalendarId = cal.id;
  const rules = [
    ['next', '顺延至下一工作日', '周六日/假日 → 下周一或节后'],
    ['prev', '提前至上一工作日', '周六日/假日 → 周五或节前'],
    ['nearest', '就近顺延', '距离最近的作日，等距向后'],
    ['none', '不顺延', '按原始日期排期'],
  ];
  $('#calendarSettings').innerHTML = `
    <div class="form-grid">
      <label class="field"><span>日历</span>
        <select id="calSelect">${state.calendars.map((c) => `<option value="${c.id}" ${c.id === cal.id ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>周末顺延规则</span>
        <select id="calRule">${rules.map(([v, t]) => `<option value="${v}" ${cal.weekend_rule === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      </label>
      <label class="field"><span>周末是否可作为结算日</span>
        <select id="calWeekend"><option value="0" ${!cal.weekend_enabled ? 'selected' : ''}>否（周末顺延）</option><option value="1" ${cal.weekend_enabled ? 'selected' : ''}>是（仅假日顺延）</option></select>
      </label>
    </div>
    <p class="hint" style="margin-top:8px">${rules.find((r) => r[0] === cal.weekend_rule)?.[2] || ''}</p>
    <div class="section-label">导入的假日（${cal.holidays.length} 天）</div>
    <div class="holiday-list" id="holidayList">
      ${cal.holidays.length ? cal.holidays.map((h) => `<span class="holiday-chip">${h}<button data-holiday="${h}" title="移除">×</button></span>`).join('') : '<span class="muted">无</span>'}
    </div>
    <div class="field-row">
      <label class="field" style="flex:1"><span>添加假日</span><input type="date" id="newHoliday" /></label>
      <label class="field" style="flex:1"><span>批量导入（逗号或换行分隔）</span><input id="bulkHolidays" placeholder="2026-12-25, 2026-12-26" /></label>
    </div>
    <div class="btn-row" style="margin-top:10px">
      <button class="btn ghost sm" id="addHolidayBtn">添加单个</button>
      <button class="btn ghost sm" id="addBulkBtn">批量加入</button>
      <button class="btn primary sm" id="saveCalendar">保存日历</button>
    </div>
    <p class="hint" style="margin-top:8px">日历只影响“预计结算日”的顺延结果，不改变账面到期日。</p>`;

  $('#calSelect').addEventListener('change', async (e) => {
    const newCal = state.calendars.find((c) => c.id === Number(e.target.value));
    if (!newCal) return;
    try {
      const { calendar } = await api(`/api/calendars/${newCal.id}`, { method: 'PATCH', body: { is_default: true } });
      state.calendars = state.calendars.map((c) => (c.id === calendar.id ? calendar : c));
      state.activeCalendarId = calendar.id;
      toast(`已切换到「${calendar.name}」`);
      await window.cashplan?.loadForecast?.();
      renderCalendar();
    } catch (err) { toast(err.message, 'err'); }
  });
  $('#addHolidayBtn').addEventListener('click', async () => {
    const val = $('#newHoliday').value;
    if (!val) return toast('请选择日期', 'err');
    await addHolidays([val]);
  });
  $('#addBulkBtn').addEventListener('click', async () => {
    const raw = $('#bulkHolidays').value;
    const dates = raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
    if (!dates.length) return toast('请输入日期', 'err');
    await addHolidays(dates);
  });
  $$('[data-holiday]').forEach((b) => b.addEventListener('click', async () => {
    const remaining = cal.holidays.filter((h) => h !== b.dataset.holiday);
    await saveCalendarPatch({ holidays: remaining });
  }));
  $('#saveCalendar').addEventListener('click', async () => {
    await saveCalendarPatch({
      weekend_rule: $('#calRule').value,
      weekend_enabled: $('#calWeekend').value === '1',
    });
  });
}

async function addHolidays(dates) {
  const cal = state.calendars.find((c) => c.id === state.activeCalendarId);
  const all = [...new Set([...cal.holidays, ...dates])].sort();
  await saveCalendarPatch({ holidays: all });
}

async function saveCalendarPatch(patch) {
  try {
    const { calendar } = await api(`/api/calendars/${state.activeCalendarId}`, { method: 'PATCH', body: patch });
    state.calendars = state.calendars.map((c) => (c.id === calendar.id ? calendar : c));
    toast('日历已保存');
    await window.cashplan?.loadForecast?.();
    renderCalendar();
  } catch (err) { toast(err.message, 'err'); }
}

function renderFx(s) {
  const currencies = new Set([s.base_currency, ...Object.keys(s.fx_rates || {})]);
  for (const ob of state.forecast?.unpriced || []) currencies.add(ob.currency);
  const list = [...currencies].filter((c) => c !== s.base_currency).sort();
  $('#fxSettings').innerHTML = list.length
    ? list.map((ccy) => {
      const val = s.fx_rates?.[ccy];
      const missing = !(Number(val) > 0);
      return `<div class="fx-row">
        <span class="fx-ccy">${ccy}</span>
        <input type="number" step="0.0001" data-fx="${ccy}" value="${missing ? '' : val}" placeholder="缺失" />
        <span class="fx-note">${missing ? '<span class="tag warn">缺汇率 · 相关项目单列</span>' : `1 ${ccy} = ${val} ${s.base_currency}`}</span>
      </div>`;
    }).join('') + `<div class="btn-row" style="margin-top:12px"><button class="btn primary sm" id="saveFx">保存汇率</button><span class="hint">留空表示缺失，预测中会单列而不按零计入。</span></div>`
    : '<div class="empty">仅使用本位币，无换算需求</div>';

  $('#saveFx')?.addEventListener('click', async () => {
    const rates = {};
    $$('[data-fx]').forEach((inp) => { if (inp.value.trim() !== '') rates[inp.dataset.fx] = Number(inp.value); });
    try {
      const { settings } = await api('/api/settings', { method: 'PUT', body: { fx_rates: rates } });
      state.settings = settings;
      toast('汇率已更新，预测已重算');
      await window.cashplan?.loadBootstrap?.();
      await window.cashplan?.loadForecast?.();
      renderFx(settings);
    } catch (err) { toast(err.message, 'err'); }
  });
}

export function initSettingsView() {
  $('#auditBtn').addEventListener('click', runAudit);
  $('#resetBtn').addEventListener('click', async () => {
    if (!confirm('这会清空当前数据并恢复为内置演示样本，确定继续？')) return;
    try {
      await api('/api/reset-demo', { method: 'POST' });
      toast('已恢复演示数据');
      state.scenarioId = 0;
      await window.cashplan?.refreshAll?.();
      renderSettings();
    } catch (err) { toast(err.message, 'err'); }
  });
}

export async function runAudit() {
  const host = $('#auditResult');
  host.innerHTML = '<span class="muted">核对中…</span>';
  try {
    const data = await api(`/api/audit?scenario=${state.scenarioId}`);
    host.innerHTML = `
      <div class="audit-cell"><div class="k">核对结果</div><div class="v" style="color:${data.ok ? 'var(--good-text)' : 'var(--critical-text)'}">${data.ok ? '通过' : '发现问题'}</div></div>
      <div class="audit-cell"><div class="k">单据 / 收付款</div><div class="v">${data.checks.documents} / ${data.checks.payments}</div></div>
      <div class="audit-cell"><div class="k">有效核销</div><div class="v">${data.checks.activeAllocations}</div></div>
      <div class="audit-cell"><div class="k">已撤销核销</div><div class="v">${data.checks.voidedAllocations}</div></div>
      <div class="audit-cell"><div class="k">流入 / 流出</div><div class="v">${fmt.base(data.checks.inflow)} / ${fmt.base(data.checks.outflow)}</div></div>
      <div class="audit-cell"><div class="k">缺汇率项目</div><div class="v">${data.checks.unpriced}</div></div>
      ${data.issues.length ? `<div class="audit-issues" style="grid-column:1/-1"><ul>${data.issues.map((i) => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>` : ''}`;
    if (data.ok) toast('核对通过：周汇总与明细一致');
    else toast(`发现 ${data.issues.length} 个问题`, 'err');
  } catch (err) {
    host.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
}
