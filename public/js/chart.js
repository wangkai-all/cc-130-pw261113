import { $, fmt } from './base.js';

/**
 * Two vertically stacked panels share one x scale:
 *   top:    grouped bars, weekly inflow / outflow
 *   bottom: line, week-end cash balance, with threshold + zero reference
 * A single y-scale per panel; never a dual axis.
 */

const PAD = { left: 60, right: 16, top: 14, gap: 26, bottom: 30 };
const BAR_GAP = 2;

function niceCeil(v) {
  if (!Number.isFinite(v) || v <= 0) return 100;
  const exp = Math.floor(Math.log10(v));
  const base = Math.pow(10, exp);
  const n = v / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * base;
}

function compact(n) {
  const v = Math.abs(Number(n) || 0);
  if (v >= 1e8) return (n / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (n / 1e4).toFixed(0) + '万';
  return String(Math.round(n));
}

export function renderChart(forecast) {
  const host = $('#cashChart');
  if (!host) return;
  const weeks = forecast.weeks;
  const width = Math.max(760, weeks.length * 64 + PAD.left + PAD.right);
  const flowH = 180;
  const balH = 158;
  const height = PAD.top + flowH + PAD.gap + balH + PAD.bottom;
  const innerW = width - PAD.left - PAD.right;
  const slot = innerW / weeks.length;
  const barW = Math.max(6, Math.min(20, slot * 0.32));

  const maxFlow = niceCeil(Math.max(1, ...weeks.map((w) => Math.max(w.inflow, w.outflow))));
  const balances = weeks.map((w) => w.closing);
  const worst = Math.min(0, ...balances);
  const best = Math.max(0, ...balances, forecast.summary.openingBalance, forecast.meta.safetyThreshold);
  const balMin = worst < 0 ? -niceCeil(Math.abs(worst) * 1.05) : 0;
  const balMax = niceCeil(best * 1.04) || 1;

  const flowTop = PAD.top;
  const flowBottom = flowTop + flowH;
  const balTop = flowBottom + PAD.gap;
  const balBottom = balTop + balH;

  const x = (i) => PAD.left + slot * i + slot / 2;
  const yFlow = (v) => flowBottom - (v / maxFlow) * flowH;
  const yBal = (v) => balBottom - ((v - balMin) / (balMax - balMin)) * balH;

  const tickCount = 4;
  const flowTicks = Array.from({ length: tickCount + 1 }, (_, i) => (maxFlow / tickCount) * i);
  const balTicks = Array.from({ length: tickCount + 1 }, (_, i) => balMin + ((balMax - balMin) / tickCount) * i);

  const css = getComputedStyle(document.documentElement);
  const cIn = css.getPropertyValue('--series-in').trim() || '#2a78d6';
  const cOut = css.getPropertyValue('--series-out').trim() || '#eb6834';
  const cBal = css.getPropertyValue('--series-balance').trim() || '#6250d6';
  const cCrit = css.getPropertyValue('--critical').trim() || '#d03b3b';

  const barPath = (cx, yTop, w, h) => {
    if (h <= 0.4) return '';
    const r = Math.min(4, w / 2, h);
    const x0 = cx - w / 2;
    const y0 = yTop;
    return `M${x0},${y0 + h} L${x0},${y0 + r} Q${x0},${y0} ${x0 + r},${y0} L${x0 + w - r},${y0} Q${x0 + w},${y0} ${x0 + w},${y0 + r} L${x0 + w},${y0 + h} Z`;
  };

  const parts = [];
  parts.push(`<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet" font-family="inherit">`);

  // --- flow panel grid & axis
  for (const t of flowTicks) {
    const y = yFlow(t);
    parts.push(`<line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"${t === 0 ? ' style="stroke:var(--border-strong)"' : ''}/>`);
    parts.push(`<text class="axis-label" x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${compact(t)}</text>`);
  }
  parts.push(`<text class="axis-label strong" x="${PAD.left}" y="${flowTop - 3}">周流入 / 流出（¥）</text>`);

  // --- balance panel grid & axis
  for (const t of balTicks) {
    const y = yBal(t);
    parts.push(`<line class="grid-line" x1="${PAD.left}" x2="${width - PAD.right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"${Math.abs(t) < 1e-6 ? ' style="stroke:var(--border-strong)"' : ''}/>`);
    parts.push(`<text class="axis-label" x="${PAD.left - 8}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${compact(t)}</text>`);
  }
  parts.push(`<text class="axis-label strong" x="${PAD.left}" y="${balTop - 4}">周末可用余额（¥）</text>`);

  // zero line explicit in balance panel when negative territory exists
  if (balMin < 0) {
    parts.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${yBal(0).toFixed(1)}" y2="${yBal(0).toFixed(1)}" stroke="var(--border-strong)" stroke-width="1"/>`);
  }
  // safety threshold
  const thr = forecast.meta.safetyThreshold;
  if (Number.isFinite(thr) && thr > balMin && thr < balMax) {
    const ty = yBal(thr);
    parts.push(`<line x1="${PAD.left}" x2="${width - PAD.right}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" stroke="${cCrit}" stroke-width="1.5" stroke-dasharray="5 4" opacity=".85"/>`);
    parts.push(`<text class="axis-label" x="${width - PAD.right}" y="${(ty - 5).toFixed(1)}" text-anchor="end" fill="${cCrit}">安全线 ${compact(thr)}</text>`);
  }

  // --- week bands + x labels
  weeks.forEach((w, i) => {
    const cx = x(i);
    if (i % 2 === 1) {
      parts.push(`<rect x="${(PAD.left + slot * i).toFixed(1)}" y="${flowTop}" width="${slot.toFixed(1)}" height="${(balBottom - flowTop).toFixed(1)}" fill="var(--surface-0)" opacity=".55"/>`);
    }
    parts.push(`<text class="axis-label" x="${cx.toFixed(1)}" y="${(balBottom + 15).toFixed(1)}" text-anchor="middle">W${i + 1}</text>`);
    parts.push(`<text class="axis-label" x="${cx.toFixed(1)}" y="${(balBottom + 27).toFixed(1)}" text-anchor="middle" style="font-size:9.5px">${fmt.shortDate(w.start)}</text>`);
    parts.push(`<rect class="week-hit" data-week="${i}" x="${(PAD.left + slot * i).toFixed(1)}" y="${flowTop}" width="${slot.toFixed(1)}" height="${(balBottom - flowTop).toFixed(1)}" rx="3"/>`);
    // bars
    const inH = flowBottom - yFlow(w.inflow);
    const outH = flowBottom - yFlow(w.outflow);
    const inX = cx - barW - BAR_GAP / 2;
    const outX = cx + BAR_GAP / 2;
    parts.push(`<path class="bar" data-week="${i}" d="${barPath(inX, yFlow(w.inflow), barW, inH)}" fill="${cIn}"/>`);
    parts.push(`<path class="bar" data-week="${i}" d="${barPath(outX, yFlow(w.outflow), barW, outH)}" fill="${cOut}"/>`);
  });

  // --- balance line
  const pts = weeks.map((w, i) => [x(i), yBal(w.closing)]);
  if (pts.length) {
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    parts.push(`<path d="${path}" fill="none" stroke="${cBal}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
    // dots; red when below zero or threshold
    weeks.forEach((w, i) => {
      const [px, py] = pts[i];
      const isBad = w.closing < 0;
      const isWarn = !isBad && w.closing < thr;
      parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${isBad || isWarn ? 4.5 : 3.5}" fill="${isBad ? cCrit : isWarn ? 'var(--warning)' : cBal}" stroke="var(--surface-1)" stroke-width="2"/>`);
    });
    // opening marker
    const oy = yBal(forecast.summary.openingBalance);
    parts.push(`<circle cx="${x(0).toFixed(1)}" cy="${oy.toFixed(1)}" r="3" fill="var(--surface-1)" stroke="${cBal}" stroke-width="2" stroke-dasharray="2 2"/>`);
  }

  // --- annotate minimum balance week
  const minIdx = forecast.summary.minimumBalanceWeek;
  if (minIdx != null && weeks[minIdx]) {
    const [px, py] = pts[minIdx];
    const label = `最低 ${compact(weeks[minIdx].closing)}`;
    const anchor = minIdx > weeks.length * 0.72 ? 'end' : 'start';
    const dx = anchor === 'end' ? -8 : 8;
    // keep the label inside the panel: flip above the marker when it sits near the axis
    const nearBottom = py > balBottom - 26;
    const labelY = nearBottom ? py - 11 : py + 15;
    parts.push(`<text x="${(px + dx).toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${anchor}" font-size="10.5" font-weight="650" fill="${weeks[minIdx].closing < 0 ? cCrit : 'var(--text-secondary)'}">${label}</text>`);
  }

  parts.push('</svg>');
  host.innerHTML = parts.join('');
  attachHover(host, forecast);
}

function attachHover(host, forecast) {
  const tip = ensureTip();
  const targets = [...host.querySelectorAll('[data-week]')];
  for (const el of targets) {
    el.addEventListener('mousemove', (e) => {
      const i = Number(el.dataset.week);
      const w = forecast.weeks[i];
      if (!w) return;
      tip.innerHTML = `
        <h4>W${i + 1} · ${fmt.weekRange(w.start, w.end)}</h4>
        <div class="row"><span>流入</span><span style="color:var(--series-in)">+${fmt.base(w.inflow)}</span></div>
        <div class="row"><span>流出</span><span style="color:var(--series-out)">−${fmt.base(w.outflow)}</span></div>
        <div class="row"><span>净额</span><span>${w.net >= 0 ? '+' : '−'}${fmt.base(Math.abs(w.net))}</span></div>
        <div class="row"><span>周末余额</span><span style="color:${w.closing < 0 ? 'var(--critical-text)' : 'inherit'}">${fmt.base(w.closing)}</span></div>
        <div class="row"><span>单据数</span><span>${w.items.length}</span></div>
        <div class="row" style="margin-top:4px;color:var(--text-muted);font-size:11px"><span>点击查看明细</span><span></span></div>`;
      tip.classList.add('show');
      positionTip(tip, e);
    });
    el.addEventListener('mouseleave', () => tip.classList.remove('show'));
    el.addEventListener('click', () => {
      tip.classList.remove('show');
      window.cashplan?.openWeek?.(Number(el.dataset.week));
    });
  }
}

function positionTip(tip, e) {
  const pad = 14;
  const rect = tip.getBoundingClientRect();
  let left = e.clientX + pad;
  let top = e.clientY + pad;
  if (left + rect.width > window.innerWidth - 8) left = e.clientX - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = e.clientY - rect.height - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function ensureTip() {
  let tip = document.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    document.body.appendChild(tip);
  }
  return tip;
}

export function renderChartLegend(forecast) {
  const host = $('#chartLegend');
  if (!host) return;
  host.innerHTML = `
    <span class="legend-item"><span class="legend-swatch" style="background:var(--series-in)"></span>流入</span>
    <span class="legend-item"><span class="legend-swatch" style="background:var(--series-out)"></span>流出</span>
    <span class="legend-item"><span class="legend-swatch line" style="background:var(--series-balance)"></span>周末余额</span>
    <span class="legend-item"><span class="legend-swatch dash"></span>安全线 ${fmt.base(forecast.meta.safetyThreshold)}</span>`;
}
