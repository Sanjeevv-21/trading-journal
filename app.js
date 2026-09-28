const STORAGE_KEY = 'tradingJournalTrades';

/** @typedef {{id:string,date:string,symbol:string,direction:'long'|'short',entry:number,exit:number,size:number,fees:number,notes:string,pnl:number}} Trade */

/** @type {Trade[]} */
let trades = loadTrades();
let currentDirection = 'long';

const today = new Date();
let viewYear = today.getFullYear();
let viewMonth = today.getMonth(); // 0-11

// ---------- Storage ----------
function loadTrades() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Failed to load trades', e);
    return [];
  }
}

function saveTrades() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
    return true;
  } catch (e) {
    console.error('Failed to save trades', e);
    return false;
  }
}

// ---------- P&L math ----------
function computePnl(direction, entry, exit, size, fees) {
  const raw = direction === 'long' ? (exit - entry) * size : (entry - exit) * size;
  return raw - (fees || 0);
}

// P&L as a percentage of capital deployed on the trade (entry price × size),
// which is what the dollar P&L is itself measured against -- this is the
// standard "return on this position" figure used across trading journals.
// Returns null when there's no meaningful basis (e.g. a zero entry price).
function computePnlPercent(pnl, entry, size) {
  const basis = entry * size;
  if (!basis) return null;
  return (pnl / basis) * 100;
}

function fmtMoney(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtMoneyCompact(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString()}`;
}

function fmtPercent(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

// Consistent 2-decimal formatting for price fields (entry/exit), with
// thousands separators, so a $64,000 crypto fill and a $9.50 fill read
// the same way instead of mixing raw floats.
function fmtPrice(n) {
  const num = Number(n) || 0;
  return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pad2(n) { return String(n).padStart(2, '0'); }

function parseTradeDate(iso) {
  return new Date(iso + 'T00:00:00');
}

// ---------- Stats ----------
function computeStats(list) {
  const totalTrades = list.length;
  const totalPnl = list.reduce((s, t) => s + t.pnl, 0);
  // Capital-weighted return across the whole list: total P&L over total
  // capital deployed, rather than an average of each trade's own % (which
  // would let a string of tiny trades outweigh one large one).
  const totalBasis = list.reduce((s, t) => s + (t.entry || 0) * (t.size || 0), 0);
  const totalPnlPercent = totalBasis ? (totalPnl / totalBasis) * 100 : null;

  const wins = list.filter(t => t.pnl > 0);
  const losses = list.filter(t => t.pnl < 0);
  const winRate = totalTrades ? (wins.length / totalTrades) * 100 : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  // Avg Win/Loss % is the average of each trade's own return -- this
  // answers "how big is a typical winner/loser", separate from the
  // capital-weighted total above.
  const winPercents = wins.map(t => computePnlPercent(t.pnl, t.entry, t.size)).filter(p => p !== null);
  const lossPercents = losses.map(t => computePnlPercent(t.pnl, t.entry, t.size)).filter(p => p !== null);
  const avgWinPercent = winPercents.length ? winPercents.reduce((s, p) => s + p, 0) / winPercents.length : null;
  const avgLossPercent = lossPercents.length ? lossPercents.reduce((s, p) => s + p, 0) / lossPercents.length : null;

  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);

  // Best/Worst Trade keep the same $-based definition as before; the %
  // shown alongside is that same trade's own return, not a re-ranking by %.
  const bestTrade = totalTrades ? list.reduce((a, b) => (b.pnl > a.pnl ? b : a)) : null;
  const worstTrade = totalTrades ? list.reduce((a, b) => (b.pnl < a.pnl ? b : a)) : null;
  const best = bestTrade ? bestTrade.pnl : 0;
  const worst = worstTrade ? worstTrade.pnl : 0;
  const bestPercent = bestTrade ? computePnlPercent(bestTrade.pnl, bestTrade.entry, bestTrade.size) : null;
  const worstPercent = worstTrade ? computePnlPercent(worstTrade.pnl, worstTrade.entry, worstTrade.size) : null;

  return {
    totalTrades, totalPnl, totalPnlPercent, winRate, avgWin, avgLoss, avgWinPercent, avgLossPercent,
    profitFactor, best, worst, bestPercent, worstPercent, wins, losses,
  };
}

// Current win/loss streak, the longest streak of each kind, and the
// largest peak-to-trough decline in cumulative P&L (max drawdown) --
// all computed in trade date order, matching the equity curve.
function computeStreaksAndDrawdown(list) {
  const sorted = [...list].sort((a, b) => new Date(a.date) - new Date(b.date));

  let currentStreakType = null;
  let currentStreakLen = 0;
  let bestWinStreak = 0;
  let worstLossStreak = 0;

  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let maxDrawdownPeak = 0;

  sorted.forEach(t => {
    if (t.pnl > 0) {
      currentStreakLen = currentStreakType === 'win' ? currentStreakLen + 1 : 1;
      currentStreakType = 'win';
      bestWinStreak = Math.max(bestWinStreak, currentStreakLen);
    } else if (t.pnl < 0) {
      currentStreakLen = currentStreakType === 'loss' ? currentStreakLen + 1 : 1;
      currentStreakType = 'loss';
      worstLossStreak = Math.max(worstLossStreak, currentStreakLen);
    } else {
      currentStreakType = null;
      currentStreakLen = 0;
    }

    cumulative += t.pnl;
    peak = Math.max(peak, cumulative);
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPeak = peak;
    }
  });

  const maxDrawdownPercent = maxDrawdownPeak > 0 ? (maxDrawdown / maxDrawdownPeak) * 100 : null;

  return {
    currentStreakType, currentStreakLen, bestWinStreak, worstLossStreak,
    maxDrawdown, maxDrawdownPeak, maxDrawdownPercent,
  };
}

function renderStats() {
  const stats = computeStats(trades);

  // Hero card: the one number that matters most gets real visual weight,
  // with a tinted background that reflects whether the account is up or down.
  const hero = document.getElementById('statHero');
  const totalPnlEl = document.getElementById('statTotalPnl');
  const totalPnlPctEl = document.getElementById('statTotalPnlPct');
  const totalPnlSub = document.getElementById('statTotalPnlSub');
  totalPnlEl.textContent = fmtMoney(stats.totalPnl);
  totalPnlPctEl.textContent = stats.totalTrades > 0 ? fmtPercent(stats.totalPnlPercent) : '';
  hero.classList.remove('is-positive', 'is-negative');
  if (stats.totalTrades === 0) {
    totalPnlSub.textContent = 'Add your first trade to get started';
  } else {
    if (stats.totalPnl > 0) hero.classList.add('is-positive');
    else if (stats.totalPnl < 0) hero.classList.add('is-negative');
    totalPnlSub.textContent = `${stats.winRate.toFixed(0)}% win rate across ${stats.totalTrades} trade${stats.totalTrades === 1 ? '' : 's'}`;
  }

  // Secondary stats: neutral ink by default. Color is only added where it
  // carries real meaning (a rate/ratio relative to a meaningful threshold),
  // not as decoration — this keeps the hero card the clear focal point.
  const winRateEl = document.getElementById('statWinRate');
  winRateEl.textContent = `${stats.winRate.toFixed(1)}%`;
  winRateEl.className = 'stat-value' + (stats.totalTrades > 0 && stats.winRate >= 50 ? ' accent-green-text' : '');

  document.getElementById('statTotalTrades').textContent = stats.totalTrades;

  const pfEl = document.getElementById('statProfitFactor');
  pfEl.textContent = stats.profitFactor === Infinity ? '∞' : stats.profitFactor.toFixed(2);
  pfEl.className = 'stat-value' +
    (stats.totalTrades === 0 ? '' : stats.profitFactor >= 1 ? ' accent-green-text' : ' accent-red-text');

  document.getElementById('statAvgWin').textContent = fmtMoney(stats.avgWin);
  document.getElementById('statAvgWinPct').textContent = stats.wins.length ? fmtPercent(stats.avgWinPercent) : '';
  document.getElementById('statAvgLoss').textContent = fmtMoney(stats.avgLoss);
  document.getElementById('statAvgLossPct').textContent = stats.losses.length ? fmtPercent(stats.avgLossPercent) : '';
  document.getElementById('statBestTrade').textContent = fmtMoney(stats.best);
  document.getElementById('statBestTradePct').textContent = stats.totalTrades ? fmtPercent(stats.bestPercent) : '';
  document.getElementById('statWorstTrade').textContent = fmtMoney(stats.worst);
  document.getElementById('statWorstTradePct').textContent = stats.totalTrades ? fmtPercent(stats.worstPercent) : '';

  const streaks = computeStreaksAndDrawdown(trades);
  const streakEl = document.getElementById('statCurrentStreak');
  const streakSubEl = document.getElementById('statStreakSub');
  if (!stats.totalTrades || !streaks.currentStreakType) {
    streakEl.textContent = '—';
    streakEl.className = 'stat-value';
    streakSubEl.textContent = '';
  } else {
    const isWin = streaks.currentStreakType === 'win';
    streakEl.textContent = `${streaks.currentStreakLen}${isWin ? 'W' : 'L'}`;
    streakEl.className = 'stat-value' + (isWin ? ' accent-green-text' : ' accent-red-text');
    streakSubEl.textContent = `Best: ${streaks.bestWinStreak}W · Worst: ${streaks.worstLossStreak}L`;
  }

  document.getElementById('statMaxDrawdown').textContent = fmtMoney(-Math.abs(streaks.maxDrawdown));
  document.getElementById('statMaxDrawdownPct').textContent =
    stats.totalTrades && streaks.maxDrawdown > 0 ? fmtPercent(-Math.abs(streaks.maxDrawdownPercent)) : '';
}

// ---------- Equity curve ----------
function renderChart() {
  const svg = document.getElementById('equityChart');
  const emptyEl = document.getElementById('chartEmpty');
  svg.innerHTML = '';

  if (trades.length === 0) {
    emptyEl.classList.add('show');
    return;
  }
  emptyEl.classList.remove('show');

  const sorted = [...trades].sort((a, b) => new Date(a.date) - new Date(b.date));
  let cumulative = 0;
  const points = [{ x: 0, y: 0 }];
  sorted.forEach((t, i) => {
    cumulative += t.pnl;
    points.push({ x: i + 1, y: cumulative });
  });

  const W = 800, H = 260, PAD = 30;
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minY = Math.min(0, ...ys);
  const maxY = Math.max(0, ...ys);
  const rangeY = (maxY - minY) || 1;
  const maxX = Math.max(...xs) || 1;

  const scaleX = x => PAD + (x / maxX) * (W - PAD * 2);
  const scaleY = y => H - PAD - ((y - minY) / rangeY) * (H - PAD * 2);

  const zeroY = scaleY(0);
  const ns = 'http://www.w3.org/2000/svg';

  const gridLine = document.createElementNS(ns, 'line');
  gridLine.setAttribute('x1', PAD);
  gridLine.setAttribute('x2', W - PAD);
  gridLine.setAttribute('y1', zeroY);
  gridLine.setAttribute('y2', zeroY);
  gridLine.setAttribute('stroke', getComputedStyle(document.documentElement).getPropertyValue('--ink').trim() || '#1B1B1B');
  gridLine.setAttribute('stroke-width', '1.5');
  gridLine.setAttribute('stroke-dasharray', '4 4');
  gridLine.setAttribute('opacity', '0.35');
  svg.appendChild(gridLine);

  const isPositive = cumulative >= 0;
  const lineColor = isPositive ? '#1FB579' : '#E8543F';
  const fillColor = isPositive ? 'rgba(31,181,121,0.15)' : 'rgba(232,84,63,0.15)';

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${scaleX(p.x)} ${scaleY(p.y)}`).join(' ');
  const areaPath = `${linePath} L ${scaleX(points[points.length - 1].x)} ${zeroY} L ${scaleX(0)} ${zeroY} Z`;

  const area = document.createElementNS(ns, 'path');
  area.setAttribute('d', areaPath);
  area.setAttribute('fill', fillColor);
  area.setAttribute('stroke', 'none');
  svg.appendChild(area);

  const line = document.createElementNS(ns, 'path');
  line.setAttribute('d', linePath);
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', lineColor);
  line.setAttribute('stroke-width', '3');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.appendChild(line);

  points.forEach(p => {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', scaleX(p.x));
    dot.setAttribute('cy', scaleY(p.y));
    dot.setAttribute('r', '3.5');
    dot.setAttribute('fill', getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#FFFFFF');
    dot.setAttribute('stroke', lineColor);
    dot.setAttribute('stroke-width', '2');
    svg.appendChild(dot);
  });

  document.getElementById('chartSubtitle').textContent =
    `Cumulative P&L over ${sorted.length} trade${sorted.length === 1 ? '' : 's'}`;
}

// ---------- Monthly calendar ----------
function getTradesForMonth(year, month) {
  return trades.filter(t => {
    const d = parseTradeDate(t.date);
    return d.getFullYear() === year && d.getMonth() === month;
  });
}

function getDayPnlMap(year, month) {
  const map = new Map();
  getTradesForMonth(year, month).forEach(t => {
    map.set(t.date, (map.get(t.date) || 0) + t.pnl);
  });
  return map;
}

function renderCalendar() {
  const label = new Date(viewYear, viewMonth, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  document.getElementById('monthLabel').textContent = label;

  const dayPnlMap = getDayPnlMap(viewYear, viewMonth);
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstWeekday = new Date(viewYear, viewMonth, 1).getDay();

  const grid = document.getElementById('calendarGrid');
  grid.innerHTML = '';

  for (let i = 0; i < firstWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-cell blank';
    grid.appendChild(blank);
  }

  const isCurrentMonth = viewYear === today.getFullYear() && viewMonth === today.getMonth();

  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${viewYear}-${pad2(viewMonth + 1)}-${pad2(day)}`;
    const cell = document.createElement('div');
    const pnl = dayPnlMap.has(iso) ? dayPnlMap.get(iso) : null;

    let cls = 'cal-cell empty';
    let title = 'No trades';
    if (pnl !== null) {
      cls = pnl >= 0 ? 'cal-cell profit' : 'cal-cell loss';
      title = fmtMoney(pnl);
    }
    if (isCurrentMonth && day === today.getDate()) cls += ' today';

    cell.className = cls;
    cell.title = title;
    cell.innerHTML = pnl !== null
      ? `<span class="cal-day-num">${day}</span><span class="cal-day-pnl">${fmtMoneyCompact(pnl)}</span>`
      : `<span class="cal-day-num">${day}</span>`;
    grid.appendChild(cell);
  }

  // Win-day ring: share of traded days in the month that were net profitable
  const dayValues = [...dayPnlMap.values()];
  const tradingDays = dayValues.length;
  const winDays = dayValues.filter(v => v > 0).length;
  const pct = tradingDays ? (winDays / tradingDays) * 100 : 0;

  const circumference = 263.9;
  const ring = document.getElementById('ringProgress');
  ring.style.strokeDashoffset = String(circumference * (1 - pct / 100));
  ring.style.stroke = pct >= 50 ? '#1FB579' : (tradingDays ? '#E8543F' : '#D8CBB0');
  document.getElementById('ringValue').textContent = `${Math.round(pct)}%`;
}

function renderMonthStats() {
  const monthTrades = getTradesForMonth(viewYear, viewMonth);
  const stats = computeStats(monthTrades);
  const dayPnlMap = getDayPnlMap(viewYear, viewMonth);
  const dayValues = [...dayPnlMap.values()];
  const bestDay = dayValues.length ? Math.max(...dayValues) : 0;

  const pnlEl = document.getElementById('monthPnl');
  pnlEl.textContent = fmtMoney(stats.totalPnl);
  pnlEl.className = 'month-stat-value ' +
    (stats.totalPnl > 0 ? 'accent-green-text' : stats.totalPnl < 0 ? 'accent-red-text' : '');

  document.getElementById('monthTrades').textContent = stats.totalTrades;
  document.getElementById('monthWinRate').textContent = `${stats.winRate.toFixed(0)}%`;

  const bestDayEl = document.getElementById('monthBestDay');
  bestDayEl.textContent = fmtMoney(bestDay);
  bestDayEl.className = 'month-stat-value ' + (bestDay > 0 ? 'accent-green-text' : '');
}

document.getElementById('prevMonthBtn').addEventListener('click', () => {
  viewMonth -= 1;
  if (viewMonth < 0) { viewMonth = 11; viewYear -= 1; }
  renderCalendar();
  renderMonthStats();
});

document.getElementById('nextMonthBtn').addEventListener('click', () => {
  viewMonth += 1;
  if (viewMonth > 11) { viewMonth = 0; viewYear += 1; }
  renderCalendar();
  renderMonthStats();
});

// ---------- Win / loss donut ----------
function renderDonut() {
  const donut = document.getElementById('donutChart');
  const legend = document.getElementById('donutLegend');
  const centerValue = document.getElementById('donutCenterValue');
  const total = trades.length;

  centerValue.textContent = total;

  if (total === 0) {
    donut.style.background = 'conic-gradient(#EAE1CD 0 100%)';
    donut.setAttribute('aria-label', 'Win and loss split donut chart: no trades yet');
    legend.innerHTML = '<div class="donut-legend-row muted">Add trades to see your split.</div>';
    return;
  }

  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const breakeven = total - wins - losses;

  const winPct = (wins / total) * 100;
  const lossPct = (losses / total) * 100;
  const bePct = 100 - winPct - lossPct;

  donut.style.background =
    `conic-gradient(#1FB579 0% ${winPct}%, #E8543F ${winPct}% ${winPct + lossPct}%, #D8CBB0 ${winPct + lossPct}% 100%)`;
  donut.setAttribute('aria-label', `Win and loss split: ${wins} wins, ${losses} losses out of ${total} trades`);

  const rows = [
    { label: 'Wins', count: wins, pct: winPct, dot: 'dot-green' },
    { label: 'Losses', count: losses, pct: lossPct, dot: 'dot-red' },
  ];
  if (breakeven > 0) rows.push({ label: 'Breakeven', count: breakeven, pct: bePct, dot: 'dot-empty' });

  legend.innerHTML = rows.map(r => `
    <div class="donut-legend-row">
      <i class="dot ${r.dot}" aria-hidden="true"></i>
      <span>${r.label}</span>
      <span class="donut-legend-value">${r.count} · ${r.pct.toFixed(0)}%</span>
    </div>
  `).join('');
}

// ---------- P&L by symbol bar chart ----------
function renderSymbolBars() {
  const wrap = document.getElementById('symbolBarChart');
  const emptyEl = document.getElementById('barChartEmpty');

  if (trades.length === 0) {
    wrap.innerHTML = '';
    emptyEl.classList.add('show');
    return;
  }
  emptyEl.classList.remove('show');

  const bySymbol = new Map();
  trades.forEach(t => bySymbol.set(t.symbol, (bySymbol.get(t.symbol) || 0) + t.pnl));

  const rows = [...bySymbol.entries()]
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 8);

  const maxAbs = Math.max(...rows.map(r => Math.abs(r[1])), 1);

  wrap.innerHTML = rows.map(([symbol, pnl]) => {
    const widthPct = Math.max((Math.abs(pnl) / maxAbs) * 100, 4);
    const cls = pnl >= 0 ? 'positive' : 'negative';
    return `
      <div class="bar-row">
        <span class="bar-symbol">${escapeHtml(symbol)}</span>
        <div class="bar-track"><div class="bar-fill ${cls}" style="width:${widthPct}%"></div></div>
        <span class="bar-value pnl-cell ${cls}">${fmtMoney(pnl)}</span>
      </div>
    `;
  }).join('');
}

// ---------- Table ----------
let sortColumn = 'date';
let sortDir = 'desc'; // 'asc' | 'desc'

function getFilteredTrades() {
  const symbolFilter = document.getElementById('filterSymbol').value.trim().toUpperCase();
  const outcomeFilter = document.getElementById('filterOutcome').value;

  const dir = sortDir === 'asc' ? 1 : -1;
  const comparators = {
    date: (a, b) => (new Date(a.date) - new Date(b.date)) * dir,
    symbol: (a, b) => a.symbol.localeCompare(b.symbol) * dir,
    pnl: (a, b) => (a.pnl - b.pnl) * dir,
  };
  const comparator = comparators[sortColumn] || comparators.date;

  return [...trades]
    .sort(comparator)
    .filter(t => !symbolFilter || t.symbol.toUpperCase().includes(symbolFilter))
    .filter(t => {
      if (outcomeFilter === 'win') return t.pnl > 0;
      if (outcomeFilter === 'loss') return t.pnl < 0;
      return true;
    });
}

function setSort(column) {
  if (sortColumn === column) {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sortColumn = column;
    sortDir = column === 'symbol' ? 'asc' : 'desc';
  }
  document.querySelectorAll('.th-sort').forEach(btn => {
    const th = btn.closest('th');
    if (btn.dataset.sort === sortColumn) {
      th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.setAttribute('aria-sort', 'none');
    }
  });
  renderTable();
}

document.querySelectorAll('.th-sort').forEach(btn => {
  btn.addEventListener('click', () => setSort(btn.dataset.sort));
});

function renderTable() {
  const tbody = document.getElementById('tradeTableBody');
  const emptyEl = document.getElementById('tableEmpty');
  const list = getFilteredTrades();
  tbody.innerHTML = '';

  if (list.length === 0) {
    emptyEl.classList.add('show');
  } else {
    emptyEl.classList.remove('show');
  }

  list.forEach(t => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td data-label="Date">${formatDateDisplay(t.date)}</td>
      <td data-label="Symbol"><strong>${escapeHtml(t.symbol)}</strong></td>
      <td data-label="Side"><span class="pill pill-${t.direction}">${t.direction === 'long' ? 'Long' : 'Short'}</span></td>
      <td data-label="Entry">${fmtPrice(t.entry)}</td>
      <td data-label="Exit">${fmtPrice(t.exit)}</td>
      <td data-label="Size">${t.size}</td>
      <td data-label="Fees">${fmtMoney(t.fees || 0)}</td>
      <td data-label="P&amp;L" class="pnl-cell ${t.pnl >= 0 ? 'positive' : 'negative'}">
        <span class="pnl-cell-value">
          <span>${fmtMoney(t.pnl)}</span>
          <span class="pnl-cell-pct">${fmtPercent(computePnlPercent(t.pnl, t.entry, t.size))}</span>
        </span>
      </td>
      <td data-label="Notes" class="notes-cell" title="${escapeHtml(t.notes || '')}">${escapeHtml(t.notes || '—')}</td>
      <td class="actions-cell">
        <div class="row-actions">
          ${(t.beforeImage || t.afterImage) ? `<button class="view-shots" data-id="${t.id}" aria-label="View chart screenshots for ${escapeHtml(t.symbol)} trade from ${formatDateDisplay(t.date)}" title="View screenshots">🖼</button>` : ''}
          <button class="duplicate" data-id="${t.id}" aria-label="Duplicate ${escapeHtml(t.symbol)} trade from ${formatDateDisplay(t.date)}" title="Duplicate">⧉</button>
          <button class="edit" data-id="${t.id}" aria-label="Edit ${escapeHtml(t.symbol)} trade from ${formatDateDisplay(t.date)}" title="Edit">✎</button>
          <button class="delete" data-id="${t.id}" aria-label="Delete ${escapeHtml(t.symbol)} trade from ${formatDateDisplay(t.date)}" title="Delete">🗑</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('.view-shots').forEach(btn =>
    btn.addEventListener('click', () => openScreenshotViewer(btn.dataset.id))
  );
  tbody.querySelectorAll('.duplicate').forEach(btn =>
    btn.addEventListener('click', () => duplicateTrade(btn.dataset.id))
  );
  tbody.querySelectorAll('.edit').forEach(btn =>
    btn.addEventListener('click', () => openModal(btn.dataset.id))
  );
  tbody.querySelectorAll('.delete').forEach(btn =>
    btn.addEventListener('click', () => openConfirmDelete(btn.dataset.id, btn))
  );
}

function formatDateDisplay(iso) {
  const d = parseTradeDate(iso);
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---------- Render all ----------
function renderAll() {
  renderStats();
  renderChart();
  renderCalendar();
  renderMonthStats();
  renderDonut();
  renderSymbolBars();
  renderTable();
  updateExportAvailability();
}

function updateExportAvailability() {
  const isEmpty = trades.length === 0;
  [document.getElementById('exportBtn'), document.getElementById('sidebarExportBtn')].forEach(btn => {
    if (!btn) return;
    btn.disabled = isEmpty;
    btn.title = isEmpty ? 'Add a trade before exporting.' : 'Export all trades as a JSON file';
  });
}

// ---------- Toast notifications ----------
const toastRegion = document.getElementById('toastRegion');

function showToast(message, type = 'info', duration = 3800) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'status');
  const icon = type === 'success' ? '✓' : type === 'error' ? '!' : '•';
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${icon}</span><span>${escapeHtml(message)}</span>`;
  toastRegion.appendChild(toast);

  const remove = () => {
    toast.classList.add('toast-leaving');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    // Fallback in case the animation doesn't fire (e.g. reduced motion)
    setTimeout(() => toast.remove(), 250);
  };
  setTimeout(remove, duration);
}

// ---------- Modal ----------
const modalBackdrop = document.getElementById('modalBackdrop');
const tradeForm = document.getElementById('tradeForm');
let lastFocusedEl = null;

function openModal(id = null, { duplicateFrom = null } = {}) {
  lastFocusedEl = document.activeElement;
  tradeForm.reset();
  document.getElementById('fFees').value = 0;
  document.getElementById('fSize').value = 1;
  clearAllFieldErrors();
  resetScreenshotFields();
  setDirection('long');

  const dupeSource = duplicateFrom ? trades.find(x => x.id === duplicateFrom) : null;

  if (id) {
    const t = trades.find(x => x.id === id);
    if (!t) return;
    document.getElementById('modalTitle').textContent = 'Edit Trade';
    document.getElementById('tradeId').value = t.id;
    document.getElementById('fDate').value = t.date;
    document.getElementById('fSymbol').value = t.symbol;
    document.getElementById('fEntry').value = t.entry;
    document.getElementById('fExit').value = t.exit;
    document.getElementById('fSize').value = t.size;
    document.getElementById('fFees').value = t.fees;
    document.getElementById('fNotes').value = t.notes || '';
    if (t.beforeImage) { currentBeforeImage = t.beforeImage; setScreenshotPreview('Before', t.beforeImage); }
    if (t.afterImage) { currentAfterImage = t.afterImage; setScreenshotPreview('After', t.afterImage); }
    setDirection(t.direction);
  } else if (dupeSource) {
    // Duplicate: prefill from the source trade so a repeated setup is a
    // few tweaks away, but treat it as a brand-new trade -- today's date,
    // a fresh id, and no carried-over screenshots.
    document.getElementById('modalTitle').textContent = 'Add Trade';
    document.getElementById('tradeId').value = '';
    document.getElementById('fDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('fSymbol').value = dupeSource.symbol;
    document.getElementById('fEntry').value = dupeSource.entry;
    document.getElementById('fExit').value = dupeSource.exit;
    document.getElementById('fSize').value = dupeSource.size;
    document.getElementById('fFees').value = dupeSource.fees;
    document.getElementById('fNotes').value = dupeSource.notes || '';
    setDirection(dupeSource.direction);
  } else {
    document.getElementById('modalTitle').textContent = 'Add Trade';
    document.getElementById('tradeId').value = '';
    document.getElementById('fDate').value = new Date().toISOString().slice(0, 10);
  }
  updatePnlPreview();
  modalBackdrop.classList.add('show');
  document.getElementById('fSymbol').focus();
}

function duplicateTrade(id) {
  openModal(null, { duplicateFrom: id });
}

function closeModal() {
  modalBackdrop.classList.remove('show');
  if (lastFocusedEl) lastFocusedEl.focus();
}

function setDirection(dir) {
  currentDirection = dir;
  document.querySelectorAll('.seg-btn').forEach(btn => {
    const isActive = btn.dataset.value === dir;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  updatePnlPreview();
}

function updatePnlPreview() {
  const entry = parseFloat(document.getElementById('fEntry').value) || 0;
  const exit = parseFloat(document.getElementById('fExit').value) || 0;
  const size = parseFloat(document.getElementById('fSize').value) || 0;
  const fees = parseFloat(document.getElementById('fFees').value) || 0;
  const pnl = computePnl(currentDirection, entry, exit, size, fees);
  const pct = computePnlPercent(pnl, entry, size);
  const el = document.getElementById('pnlPreview');
  const pctEl = document.getElementById('pnlPreviewPct');
  const color = pnl > 0 ? 'var(--green-ink)' : pnl < 0 ? 'var(--red-ink)' : 'var(--violet-ink)';
  el.textContent = fmtMoney(pnl);
  el.style.color = color;
  pctEl.textContent = fmtPercent(pct);
  pctEl.style.color = color;
}

document.getElementById('addTradeBtn').addEventListener('click', () => openModal());
document.getElementById('chartEmptyAddBtn').addEventListener('click', () => openModal());
document.getElementById('tableEmptyAddBtn').addEventListener('click', () => openModal());
document.getElementById('closeModalBtn').addEventListener('click', closeModal);
document.getElementById('cancelBtn').addEventListener('click', closeModal);
modalBackdrop.addEventListener('click', e => { if (e.target === modalBackdrop) closeModal(); });

document.querySelectorAll('.seg-btn').forEach(btn => {
  btn.addEventListener('click', () => setDirection(btn.dataset.value));
});

['fEntry', 'fExit', 'fSize', 'fFees'].forEach(id => {
  document.getElementById(id).addEventListener('input', updatePnlPreview);
});

// ---------- Form validation ----------
// Errors render inline, under the field they belong to, rather than relying
// on the browser's own validation bubble (which is easy to miss and isn't
// styled to match the rest of the app).
function setFieldError(inputId, message) {
  const input = document.getElementById(inputId);
  const row = document.getElementById(inputId + 'Row');
  const errorEl = document.getElementById(inputId + 'Error');
  if (!input || !row) return;
  if (message) {
    row.classList.add('has-error');
    input.setAttribute('aria-invalid', 'true');
    if (errorEl) errorEl.textContent = message;
  } else {
    row.classList.remove('has-error');
    input.setAttribute('aria-invalid', 'false');
    if (errorEl) errorEl.textContent = '';
  }
  return message;
}

function clearAllFieldErrors() {
  ['fSymbol', 'fEntry', 'fExit', 'fSize', 'fFees'].forEach(id => setFieldError(id, ''));
}

function validateSymbol() {
  const value = document.getElementById('fSymbol').value.trim();
  return setFieldError('fSymbol', value ? '' : 'Enter a symbol, e.g. AAPL or BTCUSD.');
}
function validateEntry() {
  const value = parseFloat(document.getElementById('fEntry').value);
  return setFieldError('fEntry', Number.isFinite(value) ? '' : 'Enter the entry price.');
}
function validateExit() {
  const value = parseFloat(document.getElementById('fExit').value);
  return setFieldError('fExit', Number.isFinite(value) ? '' : 'Enter the exit price.');
}
function validateSize() {
  const value = parseFloat(document.getElementById('fSize').value);
  if (!Number.isFinite(value)) return setFieldError('fSize', 'Enter a size.');
  if (value <= 0) return setFieldError('fSize', 'Size must be greater than 0.');
  return setFieldError('fSize', '');
}
function validateFees() {
  const raw = document.getElementById('fFees').value;
  const value = raw === '' ? 0 : parseFloat(raw);
  if (!Number.isFinite(value)) return setFieldError('fFees', 'Enter a valid fee amount.');
  if (value < 0) return setFieldError('fFees', "Fees can't be negative.");
  return setFieldError('fFees', '');
}

// Validate on blur (after the person has had a chance to finish typing)
// rather than on every keystroke, so errors don't flash while a value is
// still incomplete.
document.getElementById('fSymbol').addEventListener('blur', validateSymbol);
document.getElementById('fEntry').addEventListener('blur', validateEntry);
document.getElementById('fExit').addEventListener('blur', validateExit);
document.getElementById('fSize').addEventListener('blur', validateSize);
document.getElementById('fFees').addEventListener('blur', validateFees);

function validateTradeForm() {
  const errors = [
    ['fSymbol', validateSymbol()],
    ['fEntry', validateEntry()],
    ['fExit', validateExit()],
    ['fSize', validateSize()],
    ['fFees', validateFees()],
  ].filter(([, message]) => message);
  return errors.length ? errors[0][0] : null;
}

tradeForm.addEventListener('submit', e => {
  e.preventDefault();

  const firstInvalidId = validateTradeForm();
  if (firstInvalidId) {
    document.getElementById(firstInvalidId).focus();
    return;
  }

  const id = document.getElementById('tradeId').value;
  const date = document.getElementById('fDate').value;
  const symbol = document.getElementById('fSymbol').value.trim().toUpperCase();
  const entry = parseFloat(document.getElementById('fEntry').value);
  const exit = parseFloat(document.getElementById('fExit').value);
  const size = parseFloat(document.getElementById('fSize').value);
  const fees = parseFloat(document.getElementById('fFees').value) || 0;
  const notes = document.getElementById('fNotes').value.trim();
  const pnl = computePnl(currentDirection, entry, exit, size, fees);
  const isEdit = Boolean(id);

  const beforeImage = currentBeforeImage;
  const afterImage = currentAfterImage;
  let previousSnapshot = null;

  if (id) {
    const t = trades.find(x => x.id === id);
    previousSnapshot = { ...t };
    Object.assign(t, { date, symbol, direction: currentDirection, entry, exit, size, fees, notes, pnl, beforeImage, afterImage });
  } else {
    trades.push({
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      date, symbol, direction: currentDirection, entry, exit, size, fees, notes, pnl, beforeImage, afterImage
    });
  }

  if (!saveTrades()) {
    if (id && previousSnapshot) {
      Object.assign(trades.find(x => x.id === id), previousSnapshot);
    } else {
      trades.pop();
    }
    showToast("Couldn't save — your browser's local storage is full. Try removing a screenshot or deleting an older trade, then try again.", 'error');
    return;
  }

  renderAll();
  closeModal();
  showToast(isEdit ? `${symbol} trade updated.` : `${symbol} trade added.`, 'success');
});

// ---------- Screenshots ----------
// Screenshots are stored as compressed base64 data URLs directly on the
// trade object -- this app has no backend, only localStorage. Resizing
// and re-encoding as JPEG keeps a typical chart screenshot down to
// roughly 80-200KB instead of several MB, so a journal with screenshots
// on most trades still fits comfortably under the ~5-10MB quota most
// browsers allow per site (see the save-failure handling above and in
// deleteTrade/loadSampleData/import for what happens if it doesn't).
let currentBeforeImage = null;
let currentAfterImage = null;

function compressImageFile(file, maxDim = 1280, quality = 0.75) {
  return new Promise((resolve, reject) => {
    if (!file.type || !file.type.startsWith('image/')) {
      reject(new Error('not-an-image'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read-failed'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode-failed'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width >= height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setScreenshotPreview(kind, dataUrl) {
  const thumb = document.getElementById(`f${kind}ImageThumb`);
  const placeholder = document.getElementById(`f${kind}ImagePlaceholder`);
  const removeBtn = document.getElementById(`f${kind}ImageRemove`);
  if (dataUrl) {
    thumb.src = dataUrl;
    thumb.hidden = false;
    placeholder.hidden = true;
    removeBtn.hidden = false;
  } else {
    thumb.src = '';
    thumb.hidden = true;
    placeholder.hidden = false;
    removeBtn.hidden = true;
  }
}

function resetScreenshotFields() {
  currentBeforeImage = null;
  currentAfterImage = null;
  setScreenshotPreview('Before', null);
  setScreenshotPreview('After', null);
  document.getElementById('fBeforeImageInput').value = '';
  document.getElementById('fAfterImageInput').value = '';
}

function wireScreenshotInput(kind) {
  const input = document.getElementById(`f${kind}ImageInput`);
  const removeBtn = document.getElementById(`f${kind}ImageRemove`);

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      showToast('That image is too large (max 15MB).', 'error');
      input.value = '';
      return;
    }
    try {
      const dataUrl = await compressImageFile(file);
      if (kind === 'Before') currentBeforeImage = dataUrl; else currentAfterImage = dataUrl;
      setScreenshotPreview(kind, dataUrl);
    } catch (err) {
      showToast('Could not read that image file.', 'error');
    } finally {
      input.value = '';
    }
  });

  removeBtn.addEventListener('click', () => {
    if (kind === 'Before') currentBeforeImage = null; else currentAfterImage = null;
    setScreenshotPreview(kind, null);
  });
}

wireScreenshotInput('Before');
wireScreenshotInput('After');

// ---------- Screenshot viewer ----------
const viewerBackdrop = document.getElementById('viewerBackdrop');
let viewerLastFocusedEl = null;

function setViewerPane(kind, dataUrl) {
  const img = document.getElementById(`viewer${kind}Image`);
  const empty = document.getElementById(`viewer${kind}Empty`);
  if (dataUrl) {
    img.src = dataUrl;
    img.hidden = false;
    empty.hidden = true;
  } else {
    img.src = '';
    img.hidden = true;
    empty.hidden = false;
  }
}

function openScreenshotViewer(id) {
  const t = trades.find(x => x.id === id);
  if (!t) return;
  viewerLastFocusedEl = document.activeElement;
  document.getElementById('viewerTitle').textContent = `${t.symbol} — ${formatDateDisplay(t.date)}`;
  setViewerPane('Before', t.beforeImage || null);
  setViewerPane('After', t.afterImage || null);
  viewerBackdrop.classList.add('show');
  document.getElementById('viewerCloseBtn').focus();
}

function closeScreenshotViewer() {
  viewerBackdrop.classList.remove('show');
  if (viewerLastFocusedEl) viewerLastFocusedEl.focus();
}

document.getElementById('viewerCloseBtn').addEventListener('click', closeScreenshotViewer);
viewerBackdrop.addEventListener('click', e => { if (e.target === viewerBackdrop) closeScreenshotViewer(); });

// ---------- Delete confirmation ----------
const confirmBackdrop = document.getElementById('confirmBackdrop');
const confirmMessage = document.getElementById('confirmMessage');
const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
const confirmCancelBtn = document.getElementById('confirmCancelBtn');
const confirmCloseBtn = document.getElementById('confirmCloseBtn');
let confirmLastFocusedEl = null;
let pendingConfirmAction = null;

// Generic confirm dialog -- reused by both "delete trade" and "restore
// backup" (and anything else destructive later), so there's one modal
// and one focus-trap/keyboard story instead of a copy per action.
function openConfirmDialog({ title, message, confirmLabel, onConfirm, triggerEl }) {
  pendingConfirmAction = onConfirm;
  confirmLastFocusedEl = triggerEl || document.activeElement;
  document.getElementById('confirmTitle').textContent = title;
  confirmMessage.textContent = message;
  confirmDeleteBtn.textContent = confirmLabel;
  confirmBackdrop.classList.add('show');
  confirmCancelBtn.focus();
}

function closeConfirmDelete() {
  confirmBackdrop.classList.remove('show');
  pendingConfirmAction = null;
  if (confirmLastFocusedEl) confirmLastFocusedEl.focus();
}

function openConfirmDelete(id, triggerEl) {
  const t = trades.find(x => x.id === id);
  if (!t) return;
  openConfirmDialog({
    title: 'Delete trade?',
    message: `Delete the ${t.symbol} trade from ${formatDateDisplay(t.date)}? This will permanently remove it from your journal — this cannot be undone.`,
    confirmLabel: 'Delete Trade',
    onConfirm: () => deleteTrade(id),
    triggerEl,
  });
}

function deleteTrade(id) {
  const t = trades.find(x => x.id === id);
  const previous = trades;
  trades = trades.filter(x => x.id !== id);
  if (!saveTrades()) {
    trades = previous;
    showToast('Could not delete — local storage error.', 'error');
    return;
  }
  renderAll();
  showToast(t ? `${t.symbol} trade deleted.` : 'Trade deleted.', 'success');
}

confirmDeleteBtn.addEventListener('click', () => {
  const action = pendingConfirmAction;
  closeConfirmDelete();
  if (action) action();
});
confirmCancelBtn.addEventListener('click', closeConfirmDelete);
confirmCloseBtn.addEventListener('click', closeConfirmDelete);
confirmBackdrop.addEventListener('click', e => { if (e.target === confirmBackdrop) closeConfirmDelete(); });

// ---------- Sample data ----------
function buildSampleTrades() {
  const curY = today.getFullYear();
  const curM = today.getMonth();
  let prevY = curY;
  let prevM = curM - 1;
  if (prevM < 0) { prevM = 11; prevY -= 1; }

  const clampToday = d => Math.min(d, today.getDate());
  const iso = (y, m, d) => `${y}-${pad2(m + 1)}-${pad2(d)}`;

  const specs = [
    // Previous month
    { d: iso(prevY, prevM, 4), symbol: 'AAPL', direction: 'long', entry: 190, exit: 196, size: 15, fees: 1, notes: 'Breakout above resistance, held into close.' },
    { d: iso(prevY, prevM, 5), symbol: 'TSLA', direction: 'short', entry: 245, exit: 252, size: 8, fees: 1, notes: 'Faded the pop too early.' },
    { d: iso(prevY, prevM, 6), symbol: 'NVDA', direction: 'long', entry: 118, exit: 124.5, size: 20, fees: 2, notes: 'Earnings momentum continuation.' },
    { d: iso(prevY, prevM, 8), symbol: 'SPY', direction: 'long', entry: 560, exit: 557, size: 10, fees: 1, notes: 'Chopped around VWAP, stopped out.' },
    { d: iso(prevY, prevM, 11), symbol: 'BTCUSD', direction: 'long', entry: 64000, exit: 65200, size: 0.05, fees: 3, notes: 'Weekend range breakout.' },
    { d: iso(prevY, prevM, 12), symbol: 'MSFT', direction: 'short', entry: 430, exit: 424, size: 12, fees: 1, notes: 'Rejected at prior high.' },
    { d: iso(prevY, prevM, 13), symbol: 'AMZN', direction: 'long', entry: 182, exit: 179, size: 15, fees: 1, notes: 'Entered too early, no confirmation.' },
    { d: iso(prevY, prevM, 15), symbol: 'GOOGL', direction: 'long', entry: 168, exit: 173.5, size: 18, fees: 2, notes: 'Clean trend day, trailed stop.' },
    { d: iso(prevY, prevM, 19), symbol: 'ETHUSD', direction: 'short', entry: 3400, exit: 3520, size: 0.8, fees: 2, notes: 'Squeeze against the short, cut late.' },
    { d: iso(prevY, prevM, 21), symbol: 'QQQ', direction: 'long', entry: 478, exit: 483, size: 14, fees: 1, notes: 'Gap and go continuation.' },
    { d: iso(prevY, prevM, 26), symbol: 'TSLA', direction: 'long', entry: 250, exit: 246, size: 10, fees: 1, notes: 'Reversed on weak volume, exited plan.' },
    { d: iso(prevY, prevM, 28), symbol: 'AAPL', direction: 'short', entry: 198, exit: 194, size: 12, fees: 1, notes: 'Faded overextension into resistance.' },
    // Current month
    { d: iso(curY, curM, clampToday(2)), symbol: 'NVDA', direction: 'long', entry: 121, exit: 126, size: 18, fees: 2, notes: 'Held through pullback, worked.' },
    { d: iso(curY, curM, clampToday(3)), symbol: 'SPY', direction: 'short', entry: 565, exit: 569, size: 10, fees: 1, notes: 'Wrong side of trend, cut quick.' },
    { d: iso(curY, curM, clampToday(4)), symbol: 'AAPL', direction: 'long', entry: 192, exit: 197.5, size: 16, fees: 1, notes: 'Strong reclaim of VWAP.' },
    { d: iso(curY, curM, clampToday(8)), symbol: 'BTCUSD', direction: 'short', entry: 66500, exit: 65200, size: 0.04, fees: 3, notes: 'Rejection at round number.' },
    { d: iso(curY, curM, clampToday(9)), symbol: 'MSFT', direction: 'long', entry: 432, exit: 428, size: 12, fees: 1, notes: 'No follow-through, stopped out.' },
    { d: iso(curY, curM, clampToday(10)), symbol: 'TSLA', direction: 'short', entry: 255, exit: 248, size: 8, fees: 1, notes: 'Clean break of support.' },
    { d: iso(curY, curM, clampToday(11)), symbol: 'GOOGL', direction: 'long', entry: 171, exit: 175, size: 18, fees: 2, notes: 'Trend day, added on pullback.' },
    { d: iso(curY, curM, clampToday(14)), symbol: 'QQQ', direction: 'long', entry: 482, exit: 479, size: 14, fees: 1, notes: 'Chased the open, gave it back.' },
    { d: iso(curY, curM, clampToday(15)), symbol: 'ETHUSD', direction: 'long', entry: 3450, exit: 3610, size: 0.7, fees: 2, notes: 'Breakout with volume confirmation.' },
    { d: iso(curY, curM, clampToday(16)), symbol: 'AMZN', direction: 'short', entry: 185, exit: 188, size: 15, fees: 1, notes: 'Squeeze higher, cut the loss.' },
    { d: iso(curY, curM, clampToday(17)), symbol: 'NVDA', direction: 'long', entry: 125, exit: 131, size: 20, fees: 2, notes: 'Best trade of the week, let it run.' },
    { d: iso(curY, curM, clampToday(18)), symbol: 'AAPL', direction: 'long', entry: 196, exit: 193, size: 14, fees: 1, notes: 'Late entry, chopped out.' },
  ];

  return specs.map((s, i) => ({
    id: `demo-${i}`,
    date: s.d,
    symbol: s.symbol,
    direction: s.direction,
    entry: s.entry,
    exit: s.exit,
    size: s.size,
    fees: s.fees,
    notes: s.notes,
    pnl: computePnl(s.direction, s.entry, s.exit, s.size, s.fees),
  }));
}

function loadSampleData() {
  const previous = trades;
  trades = trades.filter(t => !String(t.id).startsWith('demo-'));
  trades.push(...buildSampleTrades());
  if (!saveTrades()) {
    trades = previous;
    showToast('Could not load sample data — local storage error.', 'error');
    return;
  }
  renderAll();
  showToast('Sample trades loaded.', 'success');
}

document.getElementById('sampleDataBtn').addEventListener('click', loadSampleData);
document.getElementById('sidebarSampleDataBtn').addEventListener('click', () => {
  closeSidebar();
  loadSampleData();
});

// ---------- Filters ----------
document.getElementById('filterSymbol').addEventListener('input', renderTable);
document.getElementById('filterOutcome').addEventListener('change', renderTable);

// ---------- Export / Import ----------
document.getElementById('exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(trades, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trading-journal-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Journal exported.', 'success');
});

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported)) throw new Error('Invalid format');
      const valid = imported.filter(t => t && t.id && t.date && t.symbol);
      const existingIds = new Set(trades.map(t => t.id));
      const newOnes = valid.filter(t => !existingIds.has(t.id));
      const previous = trades;
      trades = [...trades, ...newOnes];
      if (!saveTrades()) {
        trades = previous;
        showToast('Import failed — local storage is full. Try importing fewer trades, or ones without screenshots.', 'error');
      } else {
        renderAll();
        showToast(`Imported ${newOnes.length} trade${newOnes.length === 1 ? '' : 's'}.`, 'success');
      }
    } catch (err) {
      showToast('Could not import file: invalid JSON format.', 'error');
    }
    e.target.value = '';
  };
  reader.readAsText(file);
});

// ---------- Restore backup ----------
// Distinct from Import above: Import merges in new trades and leaves
// everything else alone. Restore is a full, destructive replace -- meant
// for a backup file exported earlier -- so it always confirms first and
// swaps out the entire journal rather than adding to it.
document.getElementById('restoreBtn').addEventListener('click', () => {
  document.getElementById('restoreFile').click();
});
document.getElementById('sidebarRestoreBtn').addEventListener('click', () => {
  closeSidebar();
  document.getElementById('restoreFile').click();
});

document.getElementById('restoreFile').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    let restored;
    try {
      const parsed = JSON.parse(reader.result);
      restored = Array.isArray(parsed) ? parsed : null;
      if (!restored) throw new Error('Invalid format');
      restored = restored.filter(t => t && t.id && t.date && t.symbol);
      if (restored.length === 0) throw new Error('No valid trades in file');
    } catch (err) {
      showToast('Could not restore: that file is not a valid trading journal backup.', 'error');
      e.target.value = '';
      return;
    }

    const currentCount = trades.length;
    openConfirmDialog({
      title: 'Restore backup?',
      message: `This will replace your current ${currentCount} trade${currentCount === 1 ? '' : 's'} with the ${restored.length} trade${restored.length === 1 ? '' : 's'} in this backup file. This cannot be undone.`,
      confirmLabel: 'Restore Backup',
      onConfirm: () => {
        const previous = trades;
        trades = restored;
        if (!saveTrades()) {
          trades = previous;
          showToast("Couldn't restore — your browser's local storage is full.", 'error');
          return;
        }
        renderAll();
        showToast(`Restored ${restored.length} trade${restored.length === 1 ? '' : 's'} from backup.`, 'success');
      },
    });
    e.target.value = '';
  };
  reader.readAsText(file);
});

// ---------- Sidebar navigation ----------
const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const sidebarCollapseBtn = document.getElementById('sidebarCollapseBtn');
const hamburgerBtn = document.getElementById('hamburgerBtn');

const SIDEBAR_COLLAPSED_KEY = 'tradingJournalSidebarCollapsed';
const SIDEBAR_HIDDEN_KEY = 'tradingJournalSidebarHidden';

function isDesktopView() {
  return window.matchMedia('(min-width: 901px)').matches;
}

function updateHamburgerState() {
  const expanded = isDesktopView()
    ? !sidebar.classList.contains('hidden')
    : sidebar.classList.contains('open');
  hamburgerBtn.setAttribute('aria-expanded', String(expanded));
}

function openSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('show');
  document.body.classList.add('sidebar-lock');
  updateHamburgerState();
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('show');
  document.body.classList.remove('sidebar-lock');
  updateHamburgerState();
}

function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  sidebarCollapseBtn.textContent = collapsed ? '»' : '«';
  sidebarCollapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Minimize sidebar');
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
}

function setSidebarHidden(hidden) {
  sidebar.classList.toggle('hidden', hidden);
  localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0');
  updateHamburgerState();
}

function toggleSidebarCollapsed() {
  setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
}

function toggleSidebarHidden() {
  setSidebarHidden(!sidebar.classList.contains('hidden'));
}

// Restore last-used desktop sidebar state (minimized / hidden)
setSidebarCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1');
setSidebarHidden(localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1');
updateHamburgerState();

hamburgerBtn.addEventListener('click', () => {
  if (isDesktopView()) {
    toggleSidebarHidden();
  } else {
    openSidebar();
  }
});

document.getElementById('sidebarCloseBtn').addEventListener('click', () => {
  if (isDesktopView()) {
    toggleSidebarHidden();
  } else {
    closeSidebar();
  }
});

sidebarCollapseBtn.addEventListener('click', toggleSidebarCollapsed);

sidebarBackdrop.addEventListener('click', closeSidebar);
// Keep keyboard focus inside whichever dialog is open (a native <dialog>
// would do this for free; these are plain divs, so Tab/Shift+Tab need to
// wrap manually instead of escaping into the page behind the backdrop).
function getFocusableEls(container) {
  if (!container) return [];
  const selector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(el => el.offsetParent !== null);
}

function trapFocus(e, modalEl) {
  const focusable = getFocusableEls(modalEl);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// A modal is "open" if any backdrop currently has .show -- used to decide
// whether the n/ / shortcuts below should fire at all.
function isAnyModalOpen() {
  return [modalBackdrop, confirmBackdrop, viewerBackdrop].some(el => el.classList.contains('show'));
}

function isTypingInField(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

document.addEventListener('keydown', e => {
  // Single-key shortcuts: only when no modal is open and focus isn't
  // already in a text field (so typing "new trade" in the notes box
  // doesn't pop the modal or hijack the "/" key).
  if (!isAnyModalOpen() && !isTypingInField(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      openModal();
      return;
    }
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('filterSymbol').focus();
      return;
    }
  }

  if (e.key === 'Escape') {
    if (confirmBackdrop.classList.contains('show')) {
      closeConfirmDelete();
    } else if (viewerBackdrop.classList.contains('show')) {
      closeScreenshotViewer();
    } else if (modalBackdrop.classList.contains('show')) {
      closeModal();
    } else if (sidebar.classList.contains('open')) {
      closeSidebar();
    }
    return;
  }
  if (e.key === 'Tab') {
    if (confirmBackdrop.classList.contains('show')) {
      trapFocus(e, confirmBackdrop.querySelector('.modal'));
    } else if (viewerBackdrop.classList.contains('show')) {
      trapFocus(e, viewerBackdrop.querySelector('.modal'));
    } else if (modalBackdrop.classList.contains('show')) {
      trapFocus(e, modalBackdrop.querySelector('.modal'));
    }
  }
});

document.getElementById('sidebarAddTradeBtn').addEventListener('click', () => {
  closeSidebar();
  openModal();
});

document.getElementById('sidebarImportBtn').addEventListener('click', () => {
  closeSidebar();
  document.getElementById('importBtn').click();
});

document.getElementById('sidebarExportBtn').addEventListener('click', () => {
  closeSidebar();
  document.getElementById('exportBtn').click();
});

const navLinks = document.querySelectorAll('.sidebar-link[data-target]');

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

navLinks.forEach(link => {
  link.addEventListener('click', e => {
    e.preventDefault();
    const target = document.getElementById(link.dataset.target);
    closeSidebar();
    if (target) {
      setTimeout(() => target.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' }), 150);
    }
  });
});

// Highlight the sidebar link for whichever section is currently in view,
// so the nav reflects where you are on the page, not just where you can go.
if ('IntersectionObserver' in window) {
  const sectionIds = [...navLinks].map(link => link.dataset.target);
  const sections = sectionIds.map(id => document.getElementById(id)).filter(Boolean);

  const setActiveLink = id => {
    navLinks.forEach(link => {
      link.toggleAttribute('aria-current', link.dataset.target === id);
      if (link.dataset.target === id) link.setAttribute('aria-current', 'true');
    });
  };

  const observer = new IntersectionObserver(entries => {
    const visible = entries
      .filter(e => e.isIntersecting)
      .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
    if (visible.length > 0) {
      setActiveLink(visible[0].target.id);
    }
  }, { rootMargin: '-15% 0px -55% 0px', threshold: [0, 0.25, 0.5, 0.75, 1] });

  sections.forEach(section => observer.observe(section));
}

// ---------- Theme ----------
// The <head> of index.html already applies the saved theme before first
// paint (to avoid a light-mode flash); this just keeps the toggle button's
// label in sync and handles switching it afterwards. Re-rendering the
// equity chart on toggle picks up the new --ink/--surface colors used by
// its inline SVG colors above.
const THEME_KEY = 'tradingJournalTheme';
const themeToggleBtn = document.getElementById('themeToggleBtn');

function applyTheme(theme) {
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
  themeToggleBtn.setAttribute('aria-label', label);
  themeToggleBtn.title = label;
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const next = isDark ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
  renderChart(); // inline SVG colors are read from computed CSS vars at render time
}

applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');
themeToggleBtn.addEventListener('click', toggleTheme);

// ---------- Init ----------
renderAll();
