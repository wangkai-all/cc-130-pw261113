import { $, $$, state, fmt, escapeHtml, toast, api } from './base.js';

export async function loadUnapplied() {
  try {
    const data = await api('/api/unapplied');
    state.unappliedData = data;
    renderUnapplied(data);
  } catch (err) { toast(err.message, 'err'); }
}

function renderUnapplied(data) {
  const renderList = (kind, rows, emptyText) => {
    if (!rows.length) return `<div class="empty"><strong>没有未核销${emptyText}</strong>所有款项均已分配到单据</div>`;
    return `<div class="table-wrap"><table class="data">
      <thead><tr><th>单号</th><th>往来单位</th><th class="num">原币金额</th><th class="num">可用余额</th><th>日期</th><th></th></tr></thead>
      <tbody>${rows.map((p) => `
        <tr class="clickable" data-pay="${p.id}">
          <td class="mono">${escapeHtml(p.ref_no)}</td>
          <td>${escapeHtml(p.party)}</td>
          <td class="num amount">${fmt.money(p.amount_original, 2)} <span class="muted">${p.currency}</span></td>
          <td class="num amount"><strong>${fmt.money(p.available, 2)}</strong></td>
          <td>${fmt.date(p.received_date, 'full')}</td>
          <td class="num"><button class="btn xs primary" data-allocate="${p.id}" data-pay-kind="${kind}">核销 ›</button></td>
        </tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="margin-top:10px">${(() => {
        const byCcy = new Map();
        for (const p of rows) byCcy.set(p.currency, (byCcy.get(p.currency) || 0) + p.available);
        return '可用合计：' + [...byCcy.entries()]
          .map(([ccy, amt]) => `${fmt.money(amt, 2)} ${ccy}`).join(' · ') + '（按币种分别列示，不直接相加）';
      })()}</p>`;
  };

  $('#unappliedReceipts').innerHTML = renderList('receipt', data.receipts, '收款');
  $('#unappliedPayments').innerHTML = renderList('payment', data.payments, '付款');

  $$('#view-unapplied [data-pay]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    window.cashplan?.openPayment?.(Number(tr.dataset.pay));
  }));
  $$('#view-unapplied [data-allocate]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    window.cashplan?.openPayment?.(Number(b.dataset.allocate));
  }));
}

export function initUnappliedView() {}
