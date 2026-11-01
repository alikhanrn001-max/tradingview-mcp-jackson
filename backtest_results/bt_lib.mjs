// Offline backtest engine for XAUUSD. Pure functions over in-memory bars: no network, broker or chart access.
import { readFileSync } from 'fs';

export const SECS = { m3: 180, m15: 900, h1: 3600 };
export const MIN_SAMPLE = 30;

export function loadCsv(path) {
  return readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const c = line.split(',');
    return { t: +c[0], o: +c[2], h: +c[3], l: +c[4], c: +c[5] };
  });
}

// --- Indicators (close-based; EMA seeded with an SMA, RSI and ATR use Wilder smoothing) ---
export function ema(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  let value = bars.slice(0, period).reduce((s, b) => s + b.c, 0) / period;
  out[period - 1] = value;
  const k = 2 / (period + 1);
  for (let i = period; i < bars.length; i++) {
    value = bars[i].c * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

export function rsi(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (bars.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = bars[i].c - bars[i - 1].c;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < bars.length; i++) {
    const d = bars[i].c - bars[i - 1].c;
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export function atr(bars, period) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  const tr = i => (i === 0 ? bars[0].h - bars[0].l
    : Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  let value = 0;
  for (let i = 0; i < period; i++) value += tr(i);
  value /= period;
  out[period - 1] = value;
  for (let i = period; i < bars.length; i++) {
    value = (value * (period - 1) + tr(i)) / period;
    out[i] = value;
  }
  return out;
}

// --- New York clock ---
const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: 'numeric', minute: 'numeric', hourCycle: 'h23',
});
export function ny(t) {
  const p = Object.fromEntries(nyFormat.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
  return { day: p.weekday, date: `${p.year}-${p.month}-${p.day}`, minutes: +p.hour * 60 + +p.minute };
}
// A trading day runs from 18:00 New York to 18:00 the next day.
export const tradingDay = t => ny(t + 6 * 3600).date;

export const NY_BLOCKS = { '09:30': [570, 585], '08:20': [500, 515] };
export function inNyBlock(t, block) {
  const [from, to] = NY_BLOCKS[block];
  const m = ny(t).minutes;
  return m >= from && m < to;
}

// True for the last bar before the weekly close, including Fridays that close early for a holiday.
export function fridayCloseFlags(bars, secs) {
  return bars.map((b, i) => {
    if (ny(b.t).day !== 'Fri') return false;
    const next = bars[i + 1];
    if (next) return next.t - b.t >= 12 * 3600;
    const end = ny(b.t + secs);
    return end.day === 'Fri' && end.minutes >= 17 * 60;
  });
}

// --- 1H direction ---
export function direction(close, emaValue, rsiValue, keepBand) {
  if (emaValue === null || rsiValue === null) return null;
  if (keepBand && rsiValue >= 45 && rsiValue <= 55) return null;
  if (close > emaValue && rsiValue < 60) return 'long';
  if (close < emaValue && rsiValue > 40) return 'short';
  return null;
}

// Index of the last 1H bar fully closed at time T, or -1. This is the no-lookahead boundary.
export function lastClosedIndex(bars, secs, T) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t + secs <= T) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// --- Fills. All stops and targets trigger on the side the position would exit at. ---
export function entryFill(side, open, spread, slip) {
  return side === 'long' ? open + spread / 2 + slip : open - spread / 2 - slip;
}

export function simulateExit(side, bars, flags, startIdx, stop, tp, spread, slip) {
  const half = spread / 2;
  for (let k = startIdx; k < bars.length; k++) {
    const b = bars[k];
    let exit = null, type = null;
    if (side === 'long') {
      const o = b.o - half, l = b.l - half, h = b.h - half;
      if (o <= stop) { exit = o - slip; type = 'stop_gap'; }
      else if (l <= stop) { exit = stop - slip; type = 'stop'; } // stop wins when both are touched
      else if (h >= tp) { exit = tp; type = 'tp'; }
      else if (flags[k]) { exit = b.c - half - slip; type = 'friday'; }
    } else {
      const o = b.o + half, l = b.l + half, h = b.h + half;
      if (o >= stop) { exit = o + slip; type = 'stop_gap'; }
      else if (h >= stop) { exit = stop + slip; type = 'stop'; }
      else if (l <= tp) { exit = tp; type = 'tp'; }
      else if (flags[k]) { exit = b.c + half + slip; type = 'friday'; }
    }
    if (exit !== null) return { exit, type, exitIdx: k, exitBarT: b.t };
  }
  return null;
}

// --- Prepared data ---
export function prepare({ m3, m15, h1 }) {
  return {
    m3, m15, h1,
    m15Ema: ema(m15, 20), m15Atr: atr(m15, 14),
    h1Ema: ema(h1, 20), h1Rsi: rsi(h1, 14),
    m3Flags: m3 ? fridayCloseFlags(m3, SECS.m3) : null,
    m15Flags: fridayCloseFlags(m15, SECS.m15),
  };
}

const WARMUP_15M = 50;

// Finds 15M reactions in time order. useFilter=false is the no-direction-filter baseline.
export function findReactions(d, { keepBand, useFilter, fromT = -Infinity }, counts) {
  const out = [];
  for (let i = WARMUP_15M; i < d.m15.length; i++) {
    const b = d.m15[i], e = d.m15Ema[i], a = d.m15Atr[i];
    if (e === null || a === null) continue;
    const T = b.t + SECS.m15;
    if (T < fromT) continue;
    const side = b.l <= e && b.c > e ? 'long' : b.h >= e && b.c < e ? 'short' : null;
    if (!side) continue;
    counts.reactions++;
    if (useFilter) {
      const j = lastClosedIndex(d.h1, SECS.h1, T);
      if (j < 0) { counts.no_1h++; continue; }
      if (direction(d.h1[j].c, d.h1Ema[j], d.h1Rsi[j], keepBand) !== side) { counts.filtered_by_1h++; continue; }
    }
    const buffer = 0.1 * a;
    out.push({ i, T, side, stop: side === 'long' ? b.l - buffer : b.h + buffer, atr: a });
  }
  return out;
}

// Finds the entry bar for one reaction, or returns a reason it has none.
function entryFor(d, stage, r) {
  if (stage === 'B') {
    const next = d.m15[r.i + 1];
    return next && next.t === r.T ? { idx: r.i + 1, bars: d.m15, flags: d.m15Flags, secs: SECS.m15 } : { skip: 'no_next_bar' };
  }
  const m3 = d.m3;
  let lo = 0, hi = m3.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (m3[mid].t < r.T) lo = mid + 1; else hi = mid; }
  for (let j = lo; j < m3.length && m3[j].t < r.T + SECS.m15; j++) {
    if (j === 0) continue;
    const hit = r.side === 'long' ? m3[j].c > m3[j - 1].h : m3[j].c < m3[j - 1].l;
    if (!hit) continue;
    const next = m3[j + 1];
    return next && next.t === m3[j].t + SECS.m3 ? { idx: j + 1, bars: m3, flags: d.m3Flags, secs: SECS.m3, triggerT: m3[j].t } : { skip: 'no_next_bar' };
  }
  return { skip: 'no_trigger' };
}

// Runs one stage for one set of assumptions.
export function runStage(d, { stage, keepBand = true, useFilter = true, nyBlock = '09:30', spread = 0, slip = 0, fromT = -Infinity }) {
  const counts = { reactions: 0, no_1h: 0, filtered_by_1h: 0, no_trigger: 0, no_next_bar: 0, invalid_stop: 0, ny_block: 0, max_positions: 0, daily_stop: 0, open_at_end: 0 };
  const trades = [];
  for (const r of findReactions(d, { keepBand, useFilter, fromT }, counts)) {
    const e = entryFor(d, stage, r);
    if (e.skip) { counts[e.skip]++; continue; }
    const bar = e.bars[e.idx];
    const entryT = bar.t;
    const fill = entryFill(r.side, bar.o, spread, slip);
    const exitSideOpen = r.side === 'long' ? bar.o - spread / 2 : bar.o + spread / 2;
    const risk = r.side === 'long' ? fill - r.stop : r.stop - fill;
    if (risk <= 0 || (r.side === 'long' ? exitSideOpen <= r.stop : exitSideOpen >= r.stop)) { counts.invalid_stop++; continue; }
    if (inNyBlock(entryT, nyBlock)) { counts.ny_block++; continue; }
    // A position is only known to have closed once its exit bar has closed.
    if (trades.filter(x => x.availT > entryT).length >= 2) { counts.max_positions++; continue; }
    const day = tradingDay(entryT);
    const closedToday = trades.filter(x => x.availT <= entryT && tradingDay(x.availT - 1) === day)
      .sort((a, b) => a.availT - b.availT || a.entryT - b.entryT);
    const last2 = closedToday.slice(-2);
    if (last2.length === 2 && last2.every(x => x.r < 0)) { counts.daily_stop++; continue; }

    const tp = r.side === 'long' ? fill + 2 * risk : fill - 2 * risk;
    const x = simulateExit(r.side, e.bars, e.flags, e.idx, r.stop, tp, spread, slip);
    if (!x) { counts.open_at_end++; continue; }
    const pnl = r.side === 'long' ? x.exit - fill : fill - x.exit;
    trades.push({
      side: r.side, reactionT: r.T, entryT, fill, stop: r.stop, tp, risk, atr: r.atr,
      exit: x.exit, exitType: x.type, exitBarT: x.exitBarT, availT: x.exitBarT + e.secs, r: pnl / risk,
    });
  }
  return { trades, counts };
}

// --- Statistics ---
export function summarize(trades, { bootstrap = 0 } = {}) {
  const sorted = [...trades].sort((a, b) => a.availT - b.availT || a.entryT - b.entryT);
  const rs = sorted.map(t => t.r);
  const n = rs.length;
  const wins = rs.filter(r => r > 0), losses = rs.filter(r => r < 0);
  const grossWin = wins.reduce((s, r) => s + r, 0), grossLoss = -losses.reduce((s, r) => s + r, 0);
  let equity = 0, peak = 0, maxDd = 0, streak = 0, maxStreak = 0;
  for (const r of rs) {
    equity += r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
    streak = r < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  const medianOf = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const out = {
    trades: n,
    insufficient: n < MIN_SAMPLE,
    win_rate: n ? wins.length / n : null,
    avg_r: n ? equity / n : null,
    total_r: equity,
    profit_factor: grossLoss > 0 ? grossWin / grossLoss : null,
    max_dd_r: maxDd,
    longest_losing_streak: maxStreak,
    long: { n: sorted.filter(t => t.side === 'long').length, r: sum(sorted.filter(t => t.side === 'long'), t => t.r) },
    short: { n: sorted.filter(t => t.side === 'short').length, r: sum(sorted.filter(t => t.side === 'short'), t => t.r) },
    exits: sorted.reduce((m, t) => { m[t.exitType] = (m[t.exitType] || 0) + 1; return m; }, {}),
    median_risk: medianOf(sorted.map(t => t.risk)),
  };
  if (bootstrap && n) {
    let seed = 12345;
    const rand = () => { seed = (seed + 0x6D2B79F5) | 0; let z = Math.imul(seed ^ (seed >>> 15), 1 | seed); z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z; return ((z ^ (z >>> 14)) >>> 0) / 4294967296; };
    const means = [];
    for (let b = 0; b < bootstrap; b++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += rs[Math.floor(rand() * n)];
      means.push(s / n);
    }
    means.sort((x, y) => x - y);
    out.avg_r_ci95 = [means[Math.floor(bootstrap * 0.025)], means[Math.floor(bootstrap * 0.975)]];
  }
  return out;
}

// --- Stage A: forward returns by 1H direction, not simulated trades ---
export function stageA(h1, keepBand, horizons = [4, 8, 24]) {
  const e = ema(h1, 20), r = rsi(h1, 14);
  const lastClose = h1[h1.length - 1].t + SECS.h1;
  const result = {};
  for (const hours of horizons) {
    const samples = [];
    for (let i = WARMUP_15M; i < h1.length; i++) {
      const T = h1[i].t + SECS.h1;
      const end = T + hours * 3600;
      if (end > lastClose) break;
      let base = i + 1;
      if (base >= h1.length) break;
      const finish = lastClosedIndex(h1, SECS.h1, end);
      if (finish < base) continue;
      const pct = (h1[finish].c - h1[base].o) / h1[base].o * 100;
      samples.push({ T, pct, dir: direction(h1[i].c, e[i], r[i], keepBand) });
    }
    const group = (rows, sign) => {
      const vals = rows.map(s => s.pct * sign);
      const n = vals.length;
      const mean = n ? vals.reduce((a, b) => a + b, 0) / n : null;
      // Non-overlapping subset, so samples sharing the same price move are not counted as independent.
      const distinct = [];
      let nextT = -Infinity;
      for (const s of rows) if (s.T >= nextT) { distinct.push(s.pct * sign); nextT = s.T + hours * 3600; }
      const m = distinct.length ? distinct.reduce((a, b) => a + b, 0) / distinct.length : 0;
      const sd = distinct.length > 1 ? Math.sqrt(distinct.reduce((a, b) => a + (b - m) ** 2, 0) / (distinct.length - 1)) : 0;
      return { n, mean_pct: mean, hit_rate: n ? vals.filter(v => v > 0).length / n : null, distinct_n: distinct.length, distinct_mean_pct: m, t_stat: sd ? m / (sd / Math.sqrt(distinct.length)) : null };
    };
    result[`${hours}h`] = {
      all_bars_up: group(samples, 1),
      long: group(samples.filter(s => s.dir === 'long'), 1),
      short: group(samples.filter(s => s.dir === 'short'), -1),
      no_direction: samples.filter(s => s.dir === null).length,
    };
  }
  return result;
}
