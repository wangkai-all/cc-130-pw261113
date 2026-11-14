const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  settings: null,
  calendars: [],
  customers: [],
  scenarios: [],
  forecast: null,
  scenarioId: 0,
  docKind: '',
  docQuery: '',
  showAmounts: true,
  onlyRisk: false,
  importKind: 'documents',
  activeScenarioDraft: null,
  editingScenarioId: null,
};

const fmt = {
  money(n, digits = 0) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  },
  amount(n, ccy) {
    if (!state.showAmounts) return '••••';
    const v = Number(n) || 0;
    return `${v < 0 ? '−' : ''}${this.money(Math.abs(v), 2)}${ccy ? ' ' + ccy : ''}`;
  },
  base(n) {
    if (!state.showAmounts) return '••••';
    return `${(Number(n) || 0) < 0 ? '−' : ''}¥${this.money(Math.abs(Number(n) || 0), 0)}`;
  },
  baseFull(n) {
    if (!state.showAmounts) return '••••';
    return `${(Number(n) || 0) < 0 ? '−' : ''}¥${this.money(Math.abs(Number(n) || 0), 2)}`;
  },
  pct(n) {
    return `${(Number(n) * 100).toFixed(0)}%`;
  },
  date(iso, style = 'short') {
    if (!iso) return '—';
    const d = new Date(iso + 'T00:00:00Z');
    if (Number.isNaN(d.getTime())) return iso;
    if (style === 'full') return `${iso.slice(0, 4)}-${iso.slice(5, 7)}-${iso.slice(8, 10)}`;
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  },
  shortDate(iso) {
    if (!iso) return '—';
    return `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;
  },
  weekRange(start, end) {
    return `${this.shortDate(start)} – ${this.shortDate(end)}`;
  },
  weekday(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getUTCDay()];
  },
};

let toastTimer = new Map();
function toast(message, type = 'ok') {
  const stack = $('#toastStack');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const icon = type === 'err' ? '⚠' : '✓';
  el.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
  stack.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

/* --------------------------------------------------------------- drawer */
function openDrawer({ eyebrow = '', title = '', body = '' }) {
  $('#drawerEyebrow').textContent = eyebrow;
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = body;
  const backdrop = $('#drawerBackdrop');
  backdrop.hidden = false;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => backdrop.classList.add('show'));
  else backdrop.classList.add('show');
  $('#drawer').classList.add('open');
  $('#drawer').setAttribute('aria-hidden', 'false');
  $('#drawer').scrollTop = 0;
  $('#drawerBody').scrollTop = 0;
}
function closeDrawer() {
  const backdrop = $('#drawerBackdrop');
  backdrop.classList.remove('show');
  $('#drawer').classList.remove('open');
  $('#drawer').setAttribute('aria-hidden', 'true');
  setTimeout(() => { if (!$('#drawer').classList.contains('open')) backdrop.hidden = true; }, 200);
}
function initDrawer() {
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

export { $, $$, state, fmt, escapeHtml, toast, api, openDrawer, closeDrawer };
