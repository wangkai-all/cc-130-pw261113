import { $, $$, state, fmt, escapeHtml, toast, api, openDrawer } from './base.js';

export async function loadDocuments() {
  const params = new URLSearchParams();
  if (state.docKind) params.set('kind', state.docKind);
  if (state.docQuery) params.set('q', state.docQuery);
  params.set('limit', '1000');
  try {
    const data = await api(`/api/documents?${params}`);
    state.docRows = data.rows;
    renderDocuments(data);
  } catch (err) { toast(err.message, 'err'); }
}

export function renderDocuments(data) {
  const rows = data?.rows || state.docRows || [];
  const tbody = $('#docsTable tbody');
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="11"><div class="empty"><strong>没有匹配的单据</strong>调整筛选条件或导入单据</div></td></tr>`;
    return;
  }
  const today = state.forecast?.meta.today || new Date().toISOString().slice(0, 10);
  tbody.innerHTML = rows.map((d) => {
    const status = d.outstanding <= 0.005
      ? '<span class="tag ok">已结清</span>'
      : d.due_date < today ? `<span class="tag risk">逾期</span>` : '<span class="tag neutral">未结</span>';
    return `
      <tr class="clickable" data-doc="${d.id}">
        <td><span class="tag ${d.kind}">${d.kind === 'ar' ? '应收' : '应付'}</span></td>
        <td class="mono">${escapeHtml(d.doc_no)}</td>
        <td>${escapeHtml(d.party)}</td>
        <td><span class="tag neutral">${d.currency}</span></td>
        <td class="num amount">${fmt.money(d.amount_original, 2)}</td>
        <td class="num amount subtle">${d.allocated ? fmt.money(d.allocated, 2) : '—'}</td>
        <td class="num amount"><strong>${fmt.money(d.outstanding, 2)}</strong></td>
        <td>${fmt.date(d.due_date, 'full')}</td>
        <td>${fmt.date(d.expected_date, 'full')}</td>
        <td>${status}${d.fx_missing ? ' <span class="tag warn">缺汇率</span>' : ''}</td>
        <td class="num"><button class="btn xs ghost" data-doc-detail="${d.id}">明细 ›</button></td>
      </tr>`;
  }).join('');
  $$('#docsTable tbody tr').forEach((tr) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-doc-detail]')) return;
      openDocument(Number(tr.dataset.doc));
    });
  });
  $$('#docsTable [data-doc-detail]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    openDocument(Number(b.dataset.docDetail));
  }));
}

export async function openDocument(id) {
  try {
    const { document: doc, allocations } = await api(`/api/documents/${id}`);
    const active = allocations.filter((a) => !a.voided);
    const voided = allocations.filter((a) => a.voided);
    const today = state.forecast?.meta.today || new Date().toISOString().slice(0, 10);
    const overdue = doc.due_date < today && doc.outstanding > 0.005;

    const allocRows = (list, isVoided) => list.map((a) => `
      <tr class="${isVoided ? '' : ''}">
        <td><span class="tag ${a.payment_kind}">${a.payment_kind === 'receipt' ? '收款' : '付款'}</span></td>
        <td class="mono">${escapeHtml(a.ref_no)}</td>
        <td>${escapeHtml(a.payment_party)}</td>
        <td class="num amount">${fmt.money(a.amount, 2)} <span class="muted">${a.payment_currency}</span></td>
        <td>${fmt.date(a.allocated_date, 'full')}</td>
        <td>${isVoided ? '<span class="tag voided">已撤销</span>' : '<span class="tag ok">有效</span>'}</td>
        <td class="num">${isVoided
          ? `<button class="btn xs ghost" data-restore-alloc="${a.id}">恢复</button>`
          : `<button class="btn xs danger" data-void-alloc="${a.id}">撤销</button>`}</td>
      </tr>`).join('');

    openDrawer({
      eyebrow: `${doc.kind === 'ar' ? '应收单据' : '应付单据'} · ${escapeHtml(doc.doc_no)}`,
      title: escapeHtml(doc.party),
      body: `
        <div class="detail-grid">
          <div class="detail-cell"><div class="k">单据金额</div><div class="v">${fmt.amount(doc.amount_original, doc.currency)}</div></div>
          <div class="detail-cell"><div class="k">已核销</div><div class="v">${fmt.amount(doc.allocated, doc.currency)}</div></div>
          <div class="detail-cell"><div class="k">剩余未结</div><div class="v" style="color:${doc.outstanding > 0.005 ? 'inherit' : 'var(--good-text)'}">${fmt.amount(doc.outstanding, doc.currency)}</div></div>
          <div class="detail-cell"><div class="k">账面到期日</div><div class="v sm">${fmt.date(doc.due_date, 'full')}</div></div>
          <div class="detail-cell"><div class="k">预计结算日</div><div class="v sm">${fmt.date(doc.expected_date, 'full')}</div></div>
          <div class="detail-cell"><div class="k">状态</div><div class="v sm">${doc.outstanding <= 0.005 ? '<span class="tag ok">已结清</span>' : overdue ? '<span class="tag risk">逾期未结</span>' : '<span class="tag neutral">未结</span>'}</div></div>
        </div>
        <div class="balance-meter">
          <span>核销进度</span>
          <div class="meter-track"><div class="meter-fill ${doc.allocated >= doc.amount_original - 0.005 ? 'full' : ''}" style="width:${Math.min(100, (doc.allocated / doc.amount_original) * 100).toFixed(1)}%"></div></div>
          <span class="mono">${((doc.allocated / doc.amount_original) * 100).toFixed(0)}%</span>
        </div>
        ${doc.note ? `<p class="hint" style="margin-top:8px">备注：${escapeHtml(doc.note)}</p>` : ''}

        <p class="section-label">新增核销 · 可用${doc.kind === 'ar' ? '收款' : '付款'}单</p>
        <div id="allocCandidates"><div class="empty" style="padding:16px">加载可用收付款…</div></div>

        <p class="section-label">有效核销记录 <span class="count-pill">${active.length}</span></p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>类型</th><th>单号</th><th>往来单位</th><th class="num">核销金额</th><th>核销日期</th><th>状态</th><th></th></tr></thead>
          <tbody>${active.length ? allocRows(active, false) : '<tr><td colspan="7"><div class="empty">尚无有效核销</div></td></tr>'}</tbody>
        </table></div>
        ${voided.length ? `
          <p class="section-label">已撤销记录 <span class="count-pill">${voided.length}</span></p>
          <div class="table-wrap"><table class="data">
            <thead><tr><th>类型</th><th>单号</th><th>往来单位</th><th class="num">核销金额</th><th>核销日期</th><th>状态</th><th></th></tr></thead>
            <tbody>${allocRows(voided, true)}</tbody>
          </table></div>` : ''}
        <p class="hint" style="margin-top:12px">撤销核销会立即恢复该单据与对应收付款的可用余额；恢复时会重新校验双方余额。</p>`,
    });

    // events
    $$('.drawer-body [data-void-alloc]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('撤销这笔核销？对应单据与收付款的未结金额会恢复。')) return;
      try {
        await api(`/api/allocations/${b.dataset.voidAlloc}/void`, { method: 'POST' });
        toast('已撤销核销，未结金额已恢复');
        await refreshAll();
        openDocument(id);
      } catch (err) { toast(err.message, 'err'); }
    }));
    $$('.drawer-body [data-restore-alloc]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/allocations/${b.dataset.restoreAlloc}/restore`, { method: 'POST' });
        toast('已恢复核销');
        await refreshAll();
        openDocument(id);
      } catch (err) { toast(err.message, 'err'); }
    }));

    if (doc.outstanding > 0.005) loadAllocCandidates(doc);
    else $('#allocCandidates').innerHTML = '<div class="empty" style="padding:16px">单据已结清，无需继续核销</div>';
  } catch (err) { toast(err.message, 'err'); }
}

async function loadAllocCandidates(doc) {
  const host = $('#allocCandidates');
  try {
    const want = doc.kind === 'ar' ? 'receipt' : 'payment';
    const { rows } = await api(`/api/payments?kind=${want}`);
    const usable = rows.filter((p) => p.available > 0.005 && p.currency === doc.currency);
    if (!usable.length) {
      host.innerHTML = `<div class="empty" style="padding:16px"><strong>没有可用的${want === 'receipt' ? '收款' : '付款'}单</strong>需要同币种（${doc.currency}）且仍有可用余额</div>`;
      return;
    }
    host.innerHTML = `
      <div class="alloc-form">
        <label class="field"><span>收付款单</span>
          <select id="allocPaymentSelect">
            ${usable.map((p) => `<option value="${p.id}" data-available="${p.available}">${escapeHtml(p.ref_no)} · ${escapeHtml(p.party)} · 可用 ${fmt.money(p.available, 2)} ${p.currency}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span>核销金额（${doc.currency}）</span>
          <input id="allocAmountInput" type="number" step="0.01" min="0.01" max="${doc.outstanding}" value="${Math.min(doc.outstanding, usable[0].available).toFixed(2)}" />
        </label>
        <label class="field full"><span>核销日期</span>
          <input id="allocDateInput" type="date" value="${state.forecast?.meta.today || new Date().toISOString().slice(0, 10)}" />
        </label>
        <div class="full btn-row" style="justify-content:space-between">
          <span class="hint" id="allocLimitHint">单据未结 ${fmt.money(doc.outstanding, 2)} ${doc.currency}</span>
          <button class="btn primary sm" id="allocSubmit">核销</button>
        </div>
      </div>`;
    const sel = $('#allocPaymentSelect');
    const amt = $('#allocAmountInput');
    const hint = $('#allocLimitHint');
    const sync = () => {
      const opt = sel.selectedOptions[0];
      const avail = Number(opt?.dataset.available) || 0;
      const max = Math.min(doc.outstanding, avail);
      amt.max = max.toFixed(2);
      hint.textContent = `单据未结 ${fmt.money(doc.outstanding, 2)} · 收付款可用 ${fmt.money(avail, 2)} · 最多可核销 ${fmt.money(max, 2)} ${doc.currency}`;
    };
    sync();
    sel.addEventListener('change', sync);
    $('#allocSubmit').addEventListener('click', async () => {
      const amount = Number(amt.value);
      if (!Number.isFinite(amount) || amount <= 0) return toast('请输入大于 0 的核销金额', 'err');
      try {
        await api('/api/allocations', {
          method: 'POST',
          body: { payment_id: Number(sel.value), document_id: doc.id, amount, allocated_date: $('#allocDateInput').value },
        });
        toast('核销成功');
        await refreshAll();
        openDocument(doc.id);
      } catch (err) { toast(err.message, 'err'); }
    });
  } catch (err) {
    host.innerHTML = `<div class="empty" style="padding:16px">${escapeHtml(err.message)}</div>`;
  }
}

export async function openPayment(id) {
  try {
    const { payment, allocations } = await api(`/api/payments/${id}`);
    const active = allocations.filter((a) => !a.voided);
    const voided = allocations.filter((a) => a.voided);
    const kindLabel = payment.kind === 'receipt' ? '收款单' : '付款单';
    openDrawer({
      eyebrow: `${kindLabel} · ${escapeHtml(payment.ref_no)}`,
      title: escapeHtml(payment.party),
      body: `
        <div class="detail-grid">
          <div class="detail-cell"><div class="k">金额</div><div class="v">${fmt.amount(payment.amount_original, payment.currency)}</div></div>
          <div class="detail-cell"><div class="k">已分配</div><div class="v">${fmt.amount(payment.allocated, payment.currency)}</div></div>
          <div class="detail-cell"><div class="k">可用余额</div><div class="v" style="color:${payment.available > 0.005 ? 'var(--critical-text)' : 'var(--good-text)'}">${fmt.amount(payment.available, payment.currency)}</div></div>
          <div class="detail-cell"><div class="k">收付款日期</div><div class="v sm">${fmt.date(payment.received_date, 'full')}</div></div>
        </div>
        <div class="balance-meter">
          <span>分配进度</span>
          <div class="meter-track"><div class="meter-fill ${payment.available <= 0.005 ? 'full' : ''}" style="width:${Math.min(100, (payment.allocated / payment.amount_original) * 100).toFixed(1)}%"></div></div>
          <span class="mono">${((payment.allocated / payment.amount_original) * 100).toFixed(0)}%</span>
        </div>
        ${payment.note ? `<p class="hint" style="margin-top:8px">备注：${escapeHtml(payment.note)}</p>` : ''}

        <p class="section-label">核销到的单据 <span class="count-pill">${active.length}</span></p>
        <div class="table-wrap"><table class="data">
          <thead><tr><th>类型</th><th>单据号</th><th>往来单位</th><th class="num">核销金额</th><th>核销日期</th><th></th></tr></thead>
          <tbody>${active.length ? active.map((a) => `
            <tr class="clickable" data-open-doc="${a.document_id}">
              <td><span class="tag ${a.doc_kind}">${a.doc_kind === 'ar' ? '应收' : '应付'}</span></td>
              <td class="mono">${escapeHtml(a.doc_no)}</td>
              <td>${escapeHtml(a.doc_party)}</td>
              <td class="num amount">${fmt.money(a.amount, 2)} <span class="muted">${a.doc_currency}</span></td>
              <td>${fmt.date(a.allocated_date, 'full')}</td>
              <td class="num"><button class="btn xs danger" data-void-alloc="${a.id}">撤销</button></td>
            </tr>`).join('') : '<tr><td colspan="6"><div class="empty"><strong>尚未分配</strong>这笔款项可选择多张单据进行核销</div></td></tr>'}
          </tbody>
        </table></div>
        ${voided.length ? `<p class="section-label">已撤销 <span class="count-pill">${voided.length}</span></p>
          <div class="table-wrap"><table class="data"><tbody>${voided.map((a) => `
            <tr><td><span class="tag ${a.doc_kind}">${a.doc_kind === 'ar' ? '应收' : '应付'}</span></td>
            <td class="mono">${escapeHtml(a.doc_no)}</td><td>${escapeHtml(a.doc_party)}</td>
            <td class="num amount">${fmt.money(a.amount, 2)}</td><td>${fmt.date(a.allocated_date, 'full')}</td>
            <td><button class="btn xs ghost" data-restore-alloc="${a.id}">恢复</button></td></tr>`).join('')}</tbody></table></div>` : ''}
        ${payment.available > 0.005 ? `
          <p class="section-label">分配到应收/应付单据</p>
          <div id="payAllocPanel"><div class="empty" style="padding:16px">加载可核销单据…</div></div>` : ''}
        <p class="hint" style="margin-top:12px">一笔收付款可关联多张单据，但全部分摊金额不能超过可用余额。</p>`,
    });

    $$('.drawer-body [data-open-doc]').forEach((tr) => tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openDocument(Number(tr.dataset.openDoc));
    }));
    $$('.drawer-body [data-void-alloc]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('撤销这笔核销？对应单据的未结金额会恢复。')) return;
      try {
        await api(`/api/allocations/${b.dataset.voidAlloc}/void`, { method: 'POST' });
        toast('已撤销核销'); await refreshAll(); openPayment(id);
      } catch (err) { toast(err.message, 'err'); }
    }));
    $$('.drawer-body [data-restore-alloc]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await api(`/api/allocations/${b.dataset.restoreAlloc}/restore`, { method: 'POST' });
        toast('已恢复核销'); await refreshAll(); openPayment(id);
      } catch (err) { toast(err.message, 'err'); }
    }));

    if (payment.available > 0.005) loadPayAllocPanel(payment);
  } catch (err) { toast(err.message, 'err'); }
}

async function loadPayAllocPanel(payment) {
  const host = $('#payAllocPanel');
  try {
    const wantKind = payment.kind === 'receipt' ? 'ar' : 'ap';
    const { rows } = await api(`/api/documents?kind=${wantKind}&limit=2000`);
    const usable = rows.filter((d) => d.currency === payment.currency && d.outstanding > 0.005);
    if (!usable.length) {
      host.innerHTML = `<div class="empty" style="padding:16px"><strong>没有可核销的单据</strong>需要同币种（${payment.currency}）且未结清</div>`;
      return;
    }
    host.innerHTML = `
      <div class="alloc-form">
        <label class="field"><span>单据</span>
          <select id="payAllocDoc">${usable.map((d) => `<option value="${d.id}" data-outstanding="${d.outstanding}">${escapeHtml(d.doc_no)} · ${escapeHtml(d.party)} · 未结 ${fmt.money(d.outstanding, 2)}</option>`).join('')}</select>
        </label>
        <label class="field"><span>核销金额（${payment.currency}）</span>
          <input id="payAllocAmount" type="number" step="0.01" min="0.01" value="${Math.min(payment.available, usable[0].outstanding).toFixed(2)}" />
        </label>
        <label class="field full"><span>核销日期</span><input id="payAllocDate" type="date" value="${state.forecast?.meta.today || new Date().toISOString().slice(0, 10)}" /></label>
        <div class="full btn-row" style="justify-content:space-between">
          <span class="hint" id="payAllocHint">可用 ${fmt.money(payment.available, 2)} ${payment.currency}</span>
          <button class="btn primary sm" id="payAllocSubmit">核销</button>
        </div>
      </div>`;
    const sel = $('#payAllocDoc');
    const amt = $('#payAllocAmount');
    const hint = $('#payAllocHint');
    const sync = () => {
      const max = Math.min(payment.available, Number(sel.selectedOptions[0]?.dataset.outstanding) || 0);
      amt.max = max.toFixed(2);
      hint.textContent = `收付款可用 ${fmt.money(payment.available, 2)} · 单据未结 ${fmt.money(Number(sel.selectedOptions[0]?.dataset.outstanding), 2)} · 最多 ${fmt.money(max, 2)} ${payment.currency}`;
    };
    sync();
    sel.addEventListener('change', sync);
    $('#payAllocSubmit').addEventListener('click', async () => {
      const amount = Number(amt.value);
      if (!Number.isFinite(amount) || amount <= 0) return toast('请输入大于 0 的核销金额', 'err');
      try {
        await api('/api/allocations', {
          method: 'POST',
          body: { payment_id: payment.id, document_id: Number(sel.value), amount, allocated_date: $('#payAllocDate').value },
        });
        toast('核销成功');
        await refreshAll();
        openPayment(payment.id);
      } catch (err) { toast(err.message, 'err'); }
    });
  } catch (err) { host.innerHTML = `<div class="empty" style="padding:16px">${escapeHtml(err.message)}</div>`; }
}

export async function refreshAll() {
  await window.cashplan?.loadBootstrap?.();
  await window.cashplan?.loadForecast?.();
  if ($('#view-documents').classList.contains('active')) await loadDocuments();
  if ($('#view-unapplied').classList.contains('active')) window.cashplan?.loadUnapplied?.();
}

export function initDocumentsView() {
  $$('#docKindFilter button').forEach((b) => b.addEventListener('click', () => {
    $$('#docKindFilter button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.docKind = b.dataset.kind;
    loadDocuments();
  }));
  let timer;
  $('#docSearch').addEventListener('input', (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.docQuery = e.target.value.trim(); loadDocuments(); }, 220);
  });
}
