import { $, state, toast, api, closeDrawer } from './js/base.js';
import { loadForecast, initForecastView, openWeekDrawer } from './js/forecast.js';
import { loadDocuments, initDocumentsView, openDocument, openPayment, renderDocuments, refreshAll } from './js/documents.js';
import { loadUnapplied, initUnappliedView } from './js/unapplied.js';
import { loadScenarios, initScenariosView } from './js/scenarios.js';
import { initImportView, loadImports } from './js/import.js';
import { renderSettings, initSettingsView } from './js/settings.js';

const VIEWS = ['forecast', 'documents', 'unapplied', 'scenarios', 'import', 'settings'];

function switchView(name) {
  if (!VIEWS.includes(name)) name = 'forecast';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'documents') loadDocuments();
  if (name === 'unapplied') loadUnapplied();
  if (name === 'scenarios') loadScenarios();
  if (name === 'import') loadImports();
  if (name === 'settings') renderSettings();
  history.replaceState(null, '', `#${name}`);
}

function initTheme() {
  const saved = localStorage.getItem('cashplan-theme');
  if (saved) document.documentElement.dataset.theme = saved;
  $('#themeToggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = cur;
    localStorage.setItem('cashplan-theme', cur);
    // the chart samples CSS custom properties, so repaint it with the new theme
    if (state.forecast) import('./js/chart.js').then((m) => m.renderChart(state.forecast));
  });
}

async function loadBootstrap() {
  try {
    const data = await api('/api/bootstrap');
    state.settings = data.settings;
    state.calendars = data.calendars;
    state.customers = data.customers;
    state.scenarios = data.scenarios;
    $('#companyName').textContent = data.settings.company_name || '';
    const sel = $('#scenarioSelect');
    sel.innerHTML = `<option value="0">基准方案</option>` +
      data.scenarios.filter((s) => !s.base).map((s) => `<option value="${s.id}">${escapeHtmlLocal(s.name)}</option>`).join('');
    sel.value = String(state.scenarioId);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function escapeHtmlLocal(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initNav() {
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));
  $('#scenarioSelect').addEventListener('change', (e) => {
    state.scenarioId = Number(e.target.value);
    loadForecast();
    if (document.querySelector('#view-scenarios').classList.contains('active')) loadScenarios();
  });
}

function initDrawer() {
  $('#drawerClose').addEventListener('click', closeDrawer);
  $('#drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
}

Object.assign(window.cashplan = window.cashplan || {}, {
  loadBootstrap,
  loadScenarios,
  state,
  switchView,
  loadForecast,
  renderDocuments,
  openDocument,
  openPayment,
  openWeek: openWeekDrawer,
  loadUnapplied,
  refreshAll,
});

async function boot() {
  initTheme();
  initNav();
  initDrawer();
  initForecastView();
  initDocumentsView();
  initUnappliedView();
  initScenariosView();
  initImportView();
  initSettingsView();

  await loadBootstrap();
  await loadForecast();
  const hash = location.hash.replace('#', '');
  if (hash && VIEWS.includes(hash) && hash !== 'forecast') switchView(hash);
}

boot();
