#!/usr/bin/env node
// Export the OHLCV history TradingView will load for the active chart to CSV, with data-quality checks.
//
// Read-only with respect to trading: it never touches order, broker, alert or replay APIs.
// It temporarily changes the chart timeframe and loads history, then restores the timeframe and view.
//
// Usage: node scripts/export_ohlcv.js [--symbol OANDA:XAUUSD] [--timeframes 15,60] [--out exports]
import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { evaluate, disconnect, KNOWN_PATHS } from '../src/connection.js';
import { setTimeframe, getVisibleRange, setVisibleRange } from '../src/core/chart.js';

const CHART = KNOWN_PATHS.chartApi;
const SERIES = `${CHART}._chartWidget.model().mainSeries()`;
const REQUEST_BARS = 50000;
const LOAD_TIMEOUT_MS = 90000;
const POLL_MS = 1000;
const STABLE_POLLS = 3;

function parseArgs(argv) {
  const opts = { symbol: 'OANDA:XAUUSD', timeframes: ['15', '60'], out: 'exports' };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--symbol') opts.symbol = value;
    else if (flag === '--timeframes') opts.timeframes = value.split(',');
    else if (flag === '--out') opts.out = value;
    else throw new Error(`Unknown flag: ${flag}`);
  }
  for (const tf of opts.timeframes) {
    if (!/^\d+$/.test(tf)) throw new Error(`Only minute timeframes are supported, got: ${tf}`);
  }
  return opts;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function tfLabel(tf) {
  const mins = Number(tf);
  return mins % 60 === 0 ? `${mins / 60}h` : `${mins}m`;
}

async function readLoadState() {
  return evaluate(`
    (function() {
      var s = ${SERIES};
      return { size: s.bars().size(), endOfData: !!s.endOfData(), endOfDataType: s.endOfDataType(), loading: !!s.isLoading() };
    })()
  `);
}

// Asks for more history until TradingView reports the end of the data and the bar count stops growing.
async function loadAllHistory() {
  await evaluate(`${SERIES}.requestMoreData(${REQUEST_BARS})`);
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  let lastSize = -1;
  let stable = 0;
  let state;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    state = await readLoadState();
    stable = state.size === lastSize && !state.loading ? stable + 1 : 0;
    lastSize = state.size;
    if (state.endOfData && stable >= STABLE_POLLS) return state;
  }
  throw new Error(`History load did not finish within ${LOAD_TIMEOUT_MS / 1000}s (last state: ${JSON.stringify(state)})`);
}

async function readBars() {
  return evaluate(`
    (function() {
      var b = ${SERIES}.bars();
      var out = [];
      for (var i = b.firstIndex(); i <= b.lastIndex(); i++) {
        var v = b.valueAt(i);
        if (v) out.push([v[0], v[1], v[2], v[3], v[4], v[5] || 0]);
      }
      return out;
    })()
  `);
}

const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', hourCycle: 'h23',
});

// Spot gold's normal closures: daily 17:00-18:00 New York, and Friday 17:00 to Sunday 18:00 New York.
function isScheduledClosure(unixSeconds) {
  const parts = nyParts.formatToParts(new Date(unixSeconds * 1000));
  const day = parts.find(p => p.type === 'weekday').value;
  const hour = Number(parts.find(p => p.type === 'hour').value);
  if (day === 'Sat') return true;
  if (day === 'Sun') return hour < 18;
  if (day === 'Fri') return hour >= 17;
  return hour === 17;
}

// The 3m series opens each session at 22:03, not 22:00. Its first bars rebuild the 15m session-open
// bar exactly, so no data is lost. Only that single slot is excused; anything wider is still a gap.
function isLateSessionOpen(slot, nextBarTime, secondsPerBar) {
  return secondsPerBar === 180 && slot + secondsPerBar === nextBarTime && isScheduledClosure(slot - secondsPerBar);
}

function iso(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString();
}

export function checkBars(bars, secondsPerBar) {
  const issues = { out_of_order: [], duplicates: [], misaligned: [], bad_values: [], ohlc_inconsistent: [] };
  const unexplainedGaps = [];
  let scheduledGaps = 0;
  let scheduledMissingBars = 0;
  let unexplainedMissingBars = 0;
  let lateSessionOpenBars = 0;
  let zeroVolumeBars = 0;

  bars.forEach(([time, open, high, low, close, volume], i) => {
    const prices = [open, high, low, close];
    if (time % secondsPerBar !== 0) issues.misaligned.push(iso(time));
    if (![...prices, volume].every(Number.isFinite) || prices.some(p => p <= 0) || volume < 0) {
      issues.bad_values.push(iso(time));
    } else if (high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
      issues.ohlc_inconsistent.push(iso(time));
    }
    if (volume === 0) zeroVolumeBars++;
    if (i === 0) return;

    const prev = bars[i - 1][0];
    if (time === prev) issues.duplicates.push(iso(time));
    else if (time < prev) issues.out_of_order.push(iso(time));
    else if (time - prev > secondsPerBar) {
      let missing = 0;
      let unexplained = 0;
      let late = 0;
      for (let t = prev + secondsPerBar; t < time; t += secondsPerBar) {
        missing++;
        if (isScheduledClosure(t)) continue;
        if (isLateSessionOpen(t, time, secondsPerBar)) late++;
        else unexplained++;
      }
      if (unexplained === 0) {
        scheduledGaps++;
        scheduledMissingBars += missing - late;
        lateSessionOpenBars += late;
      } else {
        unexplainedMissingBars += unexplained + late;
        unexplainedGaps.push({ after: iso(prev), before: iso(time), missing_bars: missing, outside_schedule: unexplained + late });
      }
    }
  });

  return {
    ...issues,
    zero_volume_bars: zeroVolumeBars,
    scheduled_gaps: scheduledGaps,
    scheduled_missing_bars: scheduledMissingBars,
    late_session_open_bars: lateSessionOpenBars,
    unexplained_gap_count: unexplainedGaps.length,
    unexplained_missing_bars: unexplainedMissingBars,
    unexplained_gaps: unexplainedGaps,
  };
}

// Rebuilds each higher-timeframe bar from lower-timeframe bars over the range both cover.
function crossCheck(lowerBars, lowerSeconds, higherBars, higherSeconds) {
  const buckets = new Map();
  for (const bar of lowerBars) {
    const key = bar[0] - (bar[0] % higherSeconds);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(bar);
  }
  const expectedParts = higherSeconds / lowerSeconds;
  const start = lowerBars[0][0];
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const result = { compared: 0, skipped_partial: 0, missing_in_lower: 0, price_mismatches: [], volume_mismatches: 0 };

  for (const [time, open, high, low, close, volume] of higherBars) {
    if (time < start) continue;
    const parts = buckets.get(time);
    if (!parts) { result.missing_in_lower++; continue; }
    // A bar with absent parts can't be rebuilt faithfully, so comparing it would prove nothing.
    if (parts.length !== expectedParts) { result.skipped_partial++; continue; }
    result.compared++;
    const rebuilt = {
      open: parts[0][1],
      high: Math.max(...parts.map(p => p[2])),
      low: Math.min(...parts.map(p => p[3])),
      close: parts[parts.length - 1][4],
      volume: parts.reduce((sum, p) => sum + p[5], 0),
    };
    if (!near(open, rebuilt.open) || !near(high, rebuilt.high) || !near(low, rebuilt.low) || !near(close, rebuilt.close)) {
      result.price_mismatches.push({ time: iso(time), hourly: { open, high, low, close }, rebuilt });
    }
    if (!near(volume, rebuilt.volume)) result.volume_mismatches++;
  }
  return result;
}

function toCsv(bars) {
  const rows = bars.map(([t, o, h, l, c, v]) => `${t},${iso(t)},${o},${h},${l},${c},${v}`);
  return `time_unix,time_utc,open,high,low,close,volume\n${rows.join('\n')}\n`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const original = await evaluate(`({ symbol: ${CHART}.symbol(), resolution: String(${CHART}.resolution()) })`);
  if (original.symbol !== opts.symbol) {
    throw new Error(`Active chart is ${original.symbol}, expected ${opts.symbol}. Nothing was changed.`);
  }
  const originalView = (await getVisibleRange()).visible_range;

  const outDir = resolve(opts.out);
  mkdirSync(outDir, { recursive: true });
  const report = { symbol: opts.symbol, generated_at: new Date().toISOString(), timeframes: {} };
  const loaded = {};

  try {
    for (const tf of opts.timeframes) {
      await setTimeframe({ timeframe: tf });
      const active = await evaluate(`({ symbol: ${CHART}.symbol(), resolution: String(${CHART}.resolution()) })`);
      if (active.symbol !== opts.symbol || active.resolution !== tf) {
        throw new Error(`Chart is on ${active.symbol} ${active.resolution}, expected ${opts.symbol} ${tf}`);
      }

      const state = await loadAllHistory();
      const seconds = Number(tf) * 60;
      const all = await readBars();
      if (all.length !== state.size) throw new Error(`Read ${all.length} bars but the chart holds ${state.size}`);
      // Never export a bar that is still forming: its values can change.
      const bars = all.filter(b => b[0] + seconds <= Date.now() / 1000);
      if (bars.length === 0) throw new Error(`No completed bars for timeframe ${tf}`);

      const name = `${opts.symbol.replace(/[^A-Za-z0-9]+/g, '_')}_${tfLabel(tf)}.csv`;
      writeFileSync(resolve(outDir, name), toCsv(bars));
      loaded[tf] = bars;
      report.timeframes[tfLabel(tf)] = {
        file: name,
        bars: bars.length,
        dropped_forming_bars: all.length - bars.length,
        first_bar_utc: iso(bars[0][0]),
        last_bar_utc: iso(bars[bars.length - 1][0]),
        end_of_data_type: state.endOfDataType,
        checks: checkBars(bars, seconds),
      };
      console.log(`${tfLabel(tf)}: ${bars.length} bars -> ${name}`);
    }
  } finally {
    await setTimeframe({ timeframe: original.resolution });
    await setVisibleRange(originalView);
  }

  const sorted = [...opts.timeframes].sort((a, b) => Number(a) - Number(b));
  for (let i = 1; i < sorted.length; i++) {
    const [lo, hi] = [sorted[i - 1], sorted[i]];
    if (Number(hi) % Number(lo) !== 0) continue;
    report[`cross_check_${tfLabel(lo)}_vs_${tfLabel(hi)}`] = crossCheck(loaded[lo], Number(lo) * 60, loaded[hi], Number(hi) * 60);
  }

  const reportName = `${opts.symbol.replace(/[^A-Za-z0-9]+/g, '_')}_export_report.json`;
  writeFileSync(resolve(outDir, reportName), JSON.stringify(report, null, 2));
  console.log(`Report -> ${reportName}`);
  console.log(`Output directory: ${outDir}`);
}

// Only export when run directly, so importing checkBars never touches the chart.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (err) {
    console.error(`Export failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await disconnect();
  }
}
