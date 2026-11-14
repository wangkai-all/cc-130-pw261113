import { $, $$, state, fmt, escapeHtml, toast, api, openDrawer } from './base.js';
import { renderChart, renderChartLegend } from './chart.js';

export async function loadForecast() {
  try {
    const data = await api(`/api/forecast?scenario=${state.scenarioId}`);
    state.forecast = data;
    renderForecast();
  } catch (err) {
    toast(err.message, 'err');
  }
}

function riskLabel(w, threshold) {
  if (w.closing < 0) return '<span class="tag risk">现金缺口</span>';
  if (w.closing < threshold) return '<span class="tag warn">低于安全线</span>';
  return '<span class="tag ok">正常</span>';
}

export function renderForecast() {
  const f = state.forecast;
  if (!f) return;
  const { summary, meta } = f;
  const thr = meta.safetyThreshold;

  $('#forecastEyebrow').textContent = `${meta.weeks} 周滚动预测 · ${fmt.date(meta.start, 'full')} 起`;
  $('#forecastSub').textContent =
    `本位币 ${meta.baseCurrency} · ${meta.calendar.name || '自然日'} · 规则：${ruleLabel(meta.calendar.weekend_rule)}` +
    (meta.calendar.holidayCount ? ` · ${meta.calendar.holidayCount} 个导入假日` : '');
  $('#companyName').textContent = state.settings?.company_name || '';

  const chip = $('#scenarioChip');
  chip.className = `scenario-chip ${meta.scenario.base ? 'baseline' : ''}`;
  chip.innerHTML = `<span class="dot"></span><span>${escapeHtml(meta.scenario.name)}</span>` +
    (meta.scenario.base ? '<span class="muted">原始单据</span>' : '<span class="muted">仅调整预计日期</span>');

  renderKpis(f, thr);
  renderChart(f);
  renderChartLegend(f);
  $('#chartCaption').textContent = '柱形为周流入/流出，折线为周末可用余额；两个面板共用同一时间轴';
  $('#chartNote').innerHTML = `余额最低：W${(summary.minimumBalanceWeek ?? 0) + 1} ${fmt.base(summary.minimumBalance)} · ` +
    `缺口周 ${summary.deficitWeeks} 个 · 低于安全线 ${summary.belowThresholdWeeks} 个 · ` +
    `点击柱形或周行查看单据明细`;
  renderWeeksTable(f, thr);
  renderUnpriced(f);
  renderOverdue(f);
  $('#unpricedCount').textContent = summary.unpricedCount;

  const badge = $('#unappliedBadge');
  const un = summary.unapplied;
  const n = un.receipts.count + un.payments.count;
  badge.textContent = n;
  badge.classList.toggle('zero', n === 0);
}

function ruleLabel(rule) {
  return { none: '不顺延', next: '顺延至下一工作日', prev: '提前至上一工作日', nearest: '就近顺延' }[rule] || rule;
}

function renderKpis(f, thr) {
  const s = f.summary;
  const gap = s.minimumBalance < 0;
  const cards = [
    {
      label: '期初可用余额', value: fmt.base(s.openingBalance), foot: '按本次方案汇率折算',
      cls: '', drill: 'opening',
    },
    {
      label: `预计流入（${f.meta.weeks} 周）`, value: fmt.base(s.totalInflow), foot: `${f.weeks.filter((w) => w.inflow > 0).length} 个周有流入`, cls: 'positive', drill: 'inflow',
    },
    {
      label: `预计流出（${f.meta.weeks} 周）`, value: fmt.base(s.totalOutflow), foot: `净变化 ${s.netChange >= 0 ? '+' : '−'}${fmt.base(Math.abs(s.netChange))}`, cls: '', drill: 'outflow',
    },
    {
      label: '最低周末余额', value: fmt.base(s.minimumBalance),
      foot: s.minimumBalanceWeek != null ? `W${s.minimumBalanceWeek + 1} · ${fmt.weekRange(f.weeks[s.minimumBalanceWeek].start, f.weeks[s.minimumBalanceWeek].end)}` : '期初余额为区间内最低',
      cls: gap ? 'negative accent' : 'accent', drill: 'min',
    },
    {
      label: gap ? '最大现金缺口' : '安全线余量', value: fmt.base(gap ? s.gap : Math.max(0, s.minimumBalance - thr)),
      foot: `${s.deficitWeeks} 个缺口周 · ${s.belowThresholdWeeks} 个低于安全线`,
      cls: gap ? 'negative' : 'positive', drill: 'min',
    },
    {
      label: '逾期未结', value: `${s.overdueCount} 张`, foot: `${fmt.base(s.overdueAmountBase)} 未结`, cls: s.overdueCount ? 'negative' : '', drill: 'overdue',
    },
    {
      label: '缺汇率项目', value: `${s.unpricedCount} 项`, foot: s.unpricedByCurrency.map((b) => b.currency).join(' / ') || '无', cls: s.unpricedCount ? 'negative' : '', drill: 'unpriced',
    },
    {
      label: '未分配收付款', value: `${s.unapplied.receipts.count + s.unapplied.payments.count} 笔`,
      foot: `收款 ${fmt.base(s.unapplied.receipts.totalBase)} · 付款 ${fmt.base(s.unapplied.payments.totalBase)}`, cls: '', drill: 'unapplied',
    },
  ];
  $('#kpiGrid').innerHTML = cards.map((c) => `
    <button type="button" class="kpi kpi-btn ${c.cls}" data-drill="${c.drill}" title="下钻查看">
      <div class="kpi-label">${c.label}</div>
      <div class="kpi-value">${c.value}</div>
      <div class="kpi-foot"><span>${c.foot}</span><span class="kpi-chevron" aria-hidden="true">›</span></div>
    </button>`).join('');

  $$('#kpiGrid [data-drill]').forEach((el) => el.addEventListener('click', () => {
    const d = el.dataset.drill;
    if (d === 'min' && f.summary.minimumBalanceWeek != null) return openWeekDrawer(f.summary.minimumBalanceWeek);
    if (d === 'overdue') return scrollToPanel('#overduePanel');
    if (d === 'unpriced') return scrollToPanel('#unpricedPanel');
    if (d === 'unapplied') return window.cashplan?.switchView?.('unapplied');
    if (d === 'opening') return openOpeningDrawer();
    if (d === 'inflow' || d === 'outflow') return openFlowDrawer(d);
  }));
}

function scrollToPanel(sel) {
  const el = $(sel);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (el.animate) {
    el.animate([{ outline: '2px solid var(--accent)' }, { outline: '2px solid transparent' }], { duration: 900 });
  }
}

function renderWeeksTable(f, thr) {
  const tbody = $('#weeksTable tbody');
  const tfoot = $('#weeksTable tfoot');
  let rows = f.weeks;
  if (state.onlyRisk) rows = rows.filter((w) => w.closing < thr);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><strong>没有风险周</strong>所有周末余额均高于安全线</div></td></tr>`;
    tfoot.innerHTML = '';
    return;
  }
  tbody.innerHTML = rows.map((w) => {
    const i = f.weeks.indexOf(w);
    return `
    <tr class="clickable" data-week="${i}">
      <td class="week-cell"><div class="week-label">W${i + 1}</div><div class="week-range">${fmt.weekRange(w.start, w.end)}</div></td>
      <td>${fmt.shortDate(w.start)} – ${fmt.shortDate(w.end)}</td>
      <td class="num amount pos">${w.inflow ? '+' + fmt.base(w.inflow) : '—'}</td>
      <td class="num amount ${w.outflow ? 'neg' : 'subtle'}">${w.outflow ? '−' + fmt.base(w.outflow) : '—'}</td>
      <td class="num amount ${w.net < 0 ? 'neg' : ''}">${w.net >= 0 ? '+' : '−'}${fmt.base(Math.abs(w.net))}</td>
      <td class="num amount ${w.closing < 0 ? 'neg' : ''}"><strong>${fmt.base(w.closing)}</strong></td>
      <td>${riskLabel(w, thr)}</td>
      <td class="num"><button class="btn xs ghost" data-week-detail="${i}">${w.items.length} 张 ›</button></td>
    </tr>`;
  }).join('');
  const totals = rows.reduce((a, w) => ({ in: a.in + w.inflow, out: a.out + w.outflow }), { in: 0, out: 0 });
  tfoot.innerHTML = `<tr>
      <td colspan="2">${state.onlyRisk ? '风险周合计' : '合计'}</td>
      <td class="num amount">+${fmt.base(totals.in)}</td>
      <td class="num amount">−${fmt.base(totals.out)}</td>
      <td class="num amount">${totals.in - totals.out >= 0 ? '+' : '−'}${fmt.base(Math.abs(totals.in - totals.out))}</td>
      <td class="num amount">${fmt.base(f.summary.closingBalance)}</td>
      <td colspan="2"></td>
    </tr>`;
  $$('#weeksTable tbody tr').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-week-detail]')) return;
      openWeekDrawer(Number(tr.dataset.week));
    });
  });
  $$('[data-week-detail]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openWeekDrawer(Number(b.dataset.weekDetail));
  }));
}

function renderUnpriced(f) {
  const body = $('#unpricedBody');
  if (!f.unpriced.length) {
    body.innerHTML = `<div class="empty"><strong>没有缺汇率项目</strong>所有币种均已按本次方案汇率换算</div>`;
    return;
  }
  const byCcy = f.summary.unpricedByCurrency;
  body.innerHTML = `
    <div class="compare-grid" style="margin-bottom:12px">
      ${byCcy.map((b) => `<div class="compare-card"><div class="cc-name">${b.currency}</div>
        <div class="cc-value">${fmt.money(b.totalOriginal, 2)}</div>
        <div class="cc-delta delta-flat">${b.count} 项 · 原币合计，未折算</div></div>`).join('')}
    </div>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>来源</th><th>引用</th><th>往来单位</th><th>币种</th><th class="num">原币金额</th><th>预计日期</th><th>原因</th></tr></thead>
      <tbody>${f.unpriced.map((u) => `
        <tr>
          <td>${u.source === 'opening' ? '<span class="tag neutral">期初</span>' : `<span class="tag ${u.kind}">${u.kind === 'ar' ? '应收' : '应付'}</span>`}</td>
          <td class="mono">${escapeHtml(u.ref)}</td>
          <td>${escapeHtml(u.party || '—')}</td>
          <td><span class="tag neutral">${u.currency}</span></td>
          <td class="num amount">${fmt.money(u.amountOriginal, 2)}</td>
          <td>${u.expectedDate ? fmt.date(u.expectedDate, 'full') : '—'}</td>
          <td class="muted">汇率缺失，未按零金额并入预测</td>
        </tr>`).join('')}
      </tbody></table></div>
    <p class="hint">在「设置」中补充 ${byCcy.map((b) => b.currency).join('、')} 汇率后，这些项目会自动纳入预测。</p>`;
}

function renderOverdue(f) {
  const host = $('#overdueBody');
  loadOverdueDocs(f).then((docs) => {
    if (!docs.length) {
      host.innerHTML = `<div class="empty"><strong>没有逾期单据</strong>所有单据均在到期日前结清或未到期</div>`;
      return;
    }
    host.innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>类型</th><th>单据号</th><th>往来单位</th><th class="num">未结金额</th><th>账面到期日</th><th class="num">逾期天数</th><th>预计结算日</th><th></th></tr></thead>
      <tbody>${docs.map((d) => `
        <tr class="clickable" data-doc="${d.id}">
          <td><span class="tag ${d.kind}">${d.kind === 'ar' ? '应收' : '应付'}</span></td>
          <td class="mono">${escapeHtml(d.doc_no)}</td>
          <td>${escapeHtml(d.party)}</td>
          <td class="num amount">${fmt.amount(d.outstanding, d.currency)}</td>
          <td>${fmt.date(d.due_date, 'full')}</td>
          <td class="num"><span class="tag risk">${d.overdue_days} 天</span></td>
          <td>${fmt.date(d.expected_date, 'full')}</td>
          <td class="num"><button class="btn xs ghost" data-doc-detail="${d.id}">明细 ›</button></td>
        </tr>`).join('')}
      </tbody></table></div>`;
    $$('#overdueBody tr[data-doc]').forEach((tr) => tr.addEventListener('click', () => {
      window.cashplan?.openDocument?.(Number(tr.dataset.doc));
    }));
  });
}

async function loadOverdueDocs(f) {
  const today = f?.meta?.today;
  if (!today) return [];
  try {
    const { rows: docs } = await api('/api/documents?limit=2000');
    return docs
      .filter((d) => d.due_date < today && d.outstanding > 0.005)
      .map((d) => ({ ...d, overdue_days: Math.round((Date.parse(today) - Date.parse(d.due_date)) / 86400000) }));
  } catch { return []; }
}

/* ------------------------------------------------------------ week drawer */

export function openWeekDrawer(index) {
  const f = state.forecast;
  const w = f.weeks[index];
  if (!w) return;
  const ins = w.items.filter((it) => it.direction === 'in');
  const outs = w.items.filter((it) => it.direction === 'out');
  const thr = f.meta.safetyThreshold;
  const beyondCount = f.beyondHorizon?.length || 0;

  const itemRows = (items) => items.map((it) => `
    <tr class="clickable" data-open-doc="${it.source === 'document' ? it.id : ''}" data-open-pay="${it.source === 'payment' ? it.id : ''}">
      <td>${it.source === 'document'
        ? `<span class="tag ${it.kind}">${it.kind === 'ar' ? '应收' : '应付'}</span>`
        : `<span class="tag ${it.kind}">${it.kind === 'receipt' ? '收款' : '付款'}</span>`}</td>
      <td><span class="mono">${escapeHtml(it.ref)}</span>${it.party ? `<div class="week-range">${escapeHtml(it.party)}</div>` : ''}</td>
      <td class="num amount">${fmt.money(it.amountOriginal, 2)} <span class="muted">${it.currency}</span></td>
      <td class="num amount"><strong>${fmt.base(it.amountBase)}</strong><div class="week-range">@ ${it.rate}</div></td>
      <td>
        ${it.source === 'document' ? `
          ${it.settlementDate !== it.expectedDate ? `<span class="tag warn" title="从预计 ${it.expectedDate} 顺延 ${it.calendarShiftDays} 天">顺延 ${it.calendarShiftDays} 天</span>` : ''}
          ${it.beforePlanStart ? `<span class="tag risk" title="预计结算日 ${it.settlementDate} 早于计划起始日，已并入第 1 周">早于计划起始日</span>` : ''}
          ${it.scenarioShiftDays ? `<span class="tag risk">情景 +${it.scenarioShiftDays} 天</span>` : ''}
          ${it.overdue ? `<span class="tag risk">逾期 ${it.overdueDays} 天</span>` : ''}
        ` : (it.unallocated ? '<span class="tag warn">未分配</span>' : '<span class="tag ok">已核销</span>')}
      </td>
      <td class="num"><span class="muted">${fmt.date(it.settlementDate, 'full')}</span></td>
    </tr>`).join('');

  const emptyRow = (n) => `<tr><td colspan="6"><div class="empty">本周无${n}</div></td></tr>`;

  openDrawer({
    eyebrow: `W${index + 1} · ${fmt.weekRange(w.start, w.end)}`,
    title: `第 ${index + 1} 周 预计结算明细`,
    body: `
      <div class="detail-grid">
        <div class="detail-cell"><div class="k">期初</div><div class="v">${fmt.base(w.opening)}</div></div>
        <div class="detail-cell"><div class="k">流入</div><div class="v" style="color:var(--good-text)">+${fmt.base(w.inflow)}</div></div>
        <div class="detail-cell"><div class="k">流出</div><div class="v" style="color:var(--critical-text)">−${fmt.base(w.outflow)}</div></div>
        <div class="detail-cell"><div class="k">周末余额</div><div class="v" style="color:${w.closing < 0 ? 'var(--critical-text)' : 'inherit'}">${fmt.base(w.closing)}</div></div>
      </div>
      ${w.closing < 0 ? `<p class="hint" style="color:var(--critical-text)">该周末余额为负，缺口 ${fmt.base(-w.closing)}。可调整情景中的预计日期，或优先催收下方应收单据。</p>` : w.closing < thr ? `<p class="hint">低于安全线 ${fmt.base(thr)}，余量 ${fmt.base(w.closing - thr)}。</p>` : ''}
      <p class="section-label">预计流入 · ${ins.length} 张（未结部分）</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>类型</th><th>单据 / 单位</th><th class="num">原币未结</th><th class="num">折合 ${f.meta.baseCurrency}</th><th>标记</th><th class="num">预计结算</th></tr></thead>
        <tbody>${ins.length ? itemRows(ins) : emptyRow('流入')}</tbody>
      </table></div>
      <p class="section-label">预计流出 · ${outs.length} 张</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>类型</th><th>单据 / 单位</th><th class="num">原币未结</th><th class="num">折合 ${f.meta.baseCurrency}</th><th>标记</th><th class="num">预计结算</th></tr></thead>
        <tbody>${outs.length ? itemRows(outs) : emptyRow('流出')}</tbody>
      </table></div>
      <p class="hint" style="margin-top:14px">金额只包含单据尚未核销的余额；已核销部分不会重复计入预测。预计结算日早于计划起始日的未结单据会并入第 1 周，避免逾期款项从预测中消失；已收付款在计划起始日之前发生的，已计入期初余额，不再重复计入。${beyondCount ? `另有 ${beyondCount} 项预计在计划期后结算，未计入本表。` : ''}</p>`,
  });

  $$('.drawer-body tr[data-open-doc]').forEach((tr) => tr.addEventListener('click', () => {
    const docId = tr.dataset.openDoc;
    const payId = tr.dataset.openPay;
    if (docId) window.cashplan?.openDocument?.(Number(docId));
    else if (payId) window.cashplan?.openPayment?.(Number(payId));
  }));
}

/* ------------------------------------------------------- opening & flow drawers */

function openOpeningDrawer() {
  const f = state.forecast;
  const rows = f.openingDetail || [];
  const superseded = f.openingSuperseded || [];
  const rateSource = { base: '本位币', explicit: '单据汇率', plan: '方案汇率' };
  openDrawer({
    eyebrow: `本位币 ${f.meta.baseCurrency} · 期初`,
    title: '期初可用余额构成',
    body: rows.length ? `
      <p class="hint">各币种期初余额按本次方案汇率折算后相加。缺失汇率的币种不进入合计，单列于「缺汇率项目」。</p>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>币种</th><th class="num">原币金额</th><th class="num">汇率</th><th>汇率来源</th><th class="num">折合 ${f.meta.baseCurrency}</th><th>余额日期</th></tr></thead>
        <tbody>${rows.map((o) => `
          <tr>
            <td><span class="tag neutral">${o.currency}</span></td>
            <td class="num amount">${fmt.money(o.amountOriginal, 2)}</td>
            <td class="num mono">${o.rate}</td>
            <td>${rateSource[o.rateSource] || '方案汇率'}</td>
            <td class="num amount"><strong>${fmt.baseFull(o.amountBase)}</strong></td>
            <td class="muted">${fmt.date(o.asOf, 'full')}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="4">合计</td>
          <td class="num amount">${fmt.baseFull(f.summary.openingBalance)}</td>
          <td></td>
        </tr></tfoot>
      </table></div>
      <p class="hint" style="margin-top:12px">在「导入」中选择期初余额即可补齐或调整；同一币种+余额日期重复导入不会重复累加，同一币种仅取计划起始日前后最近一次的余额快照。</p>
      ${superseded.length ? `
        <p class="section-label">未计入的旧余额快照 · ${superseded.length} 条</p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>币种</th><th class="num">原币金额</th><th>余额日期</th><th>说明</th></tr></thead>
          <tbody>${superseded.map((o) => `
            <tr>
              <td><span class="tag neutral">${o.currency}</span></td>
              <td class="num amount">${fmt.money(o.amount, 2)}</td>
              <td class="muted">${fmt.date(o.as_of, 'full')}</td>
              <td class="muted">同币种已有更接近计划起始日的快照，避免重复计入</td>
            </tr>`).join('')}
          </tbody></table></div>` : ''}`
      : '<div class="empty"><strong>尚未录入期初余额</strong>请到「导入」导入期初余额</div>',
  });
}

function openFlowDrawer(direction) {
  const f = state.forecast;
  const isIn = direction === 'inflow';
  const label = isIn ? '流入' : '流出';
  const rateSource = { base: '本位币', explicit: '单据汇率', plan: '方案汇率' };
  const byRef = new Map();
  for (const w of f.weeks) {
    for (const it of w.items) {
      if (it.direction !== (isIn ? 'in' : 'out')) continue;
      const prev = byRef.get(it.key);
      if (prev) { prev.amountBase += it.amountBase; continue; }
      byRef.set(it.key, {
        source: it.source, id: it.id, kind: it.kind, ref: it.ref, party: it.party,
        currency: it.currency, amountOriginal: it.amountOriginal,
        outstandingOriginal: it.outstandingOriginal, rate: it.rate,
        amountBase: it.amountBase, settlementDate: it.settlementDate, week: w.index + 1,
      });
    }
  }
  const rows = [...byRef.values()].sort((a, b) => b.amountBase - a.amountBase);
  const total = f.summary[isIn ? 'totalInflow' : 'totalOutflow'];
  const kindTag = (r) => {
    if (r.source === 'document') return `<span class="tag ${r.kind}">${r.kind === 'ar' ? '应收' : '应付'}</span>`;
    return `<span class="tag ${r.kind}">${r.kind === 'receipt' ? '收款' : '付款'}</span>`;
  };
  openDrawer({
    eyebrow: `${f.meta.weeks} 周 · 折合 ${f.meta.baseCurrency}`,
    title: `预计${label}明细（${rows.length} 项）`,
    body: rows.length ? `
      <div class="detail-grid">
        <div class="detail-cell"><div class="k">合计${label}</div><div class="v">${fmt.baseFull(total)}</div></div>
        <div class="detail-cell"><div class="k">涉及单据</div><div class="v sm">${rows.filter((r) => r.source === 'document').length} 张</div></div>
        <div class="detail-cell"><div class="k">已收/付款</div><div class="v sm">${rows.filter((r) => r.source === 'payment').length} 笔</div></div>
      </div>
      <div class="table-wrap"><table class="data">
        <thead><tr><th>类型</th><th>单据 / 单位</th><th class="num">原币金额</th><th class="num">汇率</th><th class="num">折合 ${f.meta.baseCurrency}</th><th>预计结算</th><th>周</th></tr></thead>
        <tbody>${rows.map((r) => `
          <tr class="clickable" data-flow-source="${r.source}" data-flow-id="${r.id}">
            <td>${kindTag(r)}</td>
            <td><span class="mono">${escapeHtml(r.ref)}</span><div class="week-range">${escapeHtml(r.party || '—')}</div></td>
            <td class="num amount">${fmt.money(r.amountOriginal, 2)} <span class="muted">${r.currency}</span></td>
            <td class="num mono">${r.rate ?? '—'}</td>
            <td class="num amount"><strong>${fmt.baseFull(r.amountBase)}</strong></td>
            <td class="muted">${fmt.date(r.settlementDate, 'full')}</td>
            <td class="num">W${r.week}</td>
          </tr>`).join('')}
        </tbody>
        <tfoot><tr>
          <td colspan="4">合计</td>
          <td class="num amount">${fmt.baseFull(total)}</td>
          <td colspan="2"></td>
        </tr></tfoot>
      </table></div>
      <p class="hint" style="margin-top:12px">只统计单据未核销余额与已收/付款；缺汇率的项目不进入合计。点击行可下钻到单据。</p>`
      : `<div class="empty"><strong>计划期内没有预计${label}</strong>调整计划起始日或检查单据预计结算日</div>`,
  });
  $$('.drawer-body [data-flow-source]').forEach((tr) => tr.addEventListener('click', () => {
    const id = Number(tr.dataset.flowId);
    if (tr.dataset.flowSource === 'document') window.cashplan?.openDocument?.(id);
    else window.cashplan?.openPayment?.(id);
  }));
}

export function initForecastView() {  $('#onlyRisk').addEventListener('change', (e) => { state.onlyRisk = e.target.checked; renderForecast(); });
  $('#toggleAmountsBtn').addEventListener('click', (e) => {
    state.showAmounts = !state.showAmounts;
    e.target.textContent = state.showAmounts ? '隐藏金额' : '显示金额';
    renderForecast();
    if (state.docRows) window.cashplan?.renderDocuments?.();
  });
}
