// Runs the approved offline backtest. Reads CSVs from the given folder and writes only to the scratchpad.
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadCsv, prepare, runStage, summarize, stageA, ny, SECS } from './bt_lib.mjs';

const OUT = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const base = { m3: loadCsv(join(dir, 'OANDA_XAUUSD_3m.csv')), m15: loadCsv(join(dir, 'OANDA_XAUUSD_15m.csv')), h1: loadCsv(join(dir, 'OANDA_XAUUSD_1h.csv')) };
const d = prepare(base);
const m3Start = base.m3[0].t;

const COSTS = [
  { name: 'zero', spread: 0, slip: 0 },
  { name: 'spread 0.10', spread: 0.10, slip: 0 },
  { name: 'spread 0.20', spread: 0.20, slip: 0 },
  { name: 'spread 0.40', spread: 0.40, slip: 0 },
  { name: 'spread 0.80', spread: 0.80, slip: 0 },
  { name: 'slip 0.05', spread: 0, slip: 0.05 },
  { name: 'slip 0.10', spread: 0, slip: 0.10 },
  { name: 'slip 0.25', spread: 0, slip: 0.25 },
  { name: 'stress 0.80+0.25', spread: 0.80, slip: 0.25 },
];
const STAGES = { B: { stage: 'B' }, B2: { stage: 'B', fromT: m3Start }, C: { stage: 'C', fromT: m3Start } };

const results = { stageA: { keep: stageA(base.h1, true), drop: stageA(base.h1, false) }, runs: [] };
const allTrades = {};
for (const [label, stage] of Object.entries(STAGES)) {
  for (const keepBand of [true, false]) {
    for (const nyBlock of ['09:30', '08:20']) {
      for (const useFilter of [true, false]) {
        for (const c of COSTS) {
          const { trades, counts } = runStage(d, { ...stage, keepBand, nyBlock, useFilter, spread: c.spread, slip: c.slip });
          const key = [label, keepBand ? 'keep' : 'drop', nyBlock, useFilter ? 'filter' : 'baseline', c.name].join('|');
          results.runs.push({ key, stage: label, band: keepBand ? 'keep' : 'drop', ny: nyBlock, filter: useFilter, cost: c.name, counts, ...summarize(trades, { bootstrap: 5000 }) });
          allTrades[key] = trades;
        }
      }
    }
  }
}

// --- Audits on every trade in every run ---
const violations = [];
for (const [key, trades] of Object.entries(allTrades)) {
  const stage = key.split('|')[0];
  const secs = stage === 'C' ? SECS.m3 : SECS.m15;
  const block = key.split('|')[2];
  const [spreadCost, slipCost] = (() => { const c = COSTS.find(x => x.name === key.split('|')[4]); return [c.spread, c.slip]; })();
  for (const t of trades) {
    const m = ny(t.entryT).minutes;
    const [from, to] = block === '09:30' ? [570, 585] : [500, 515];
    if (t.entryT < t.reactionT) violations.push(`${key}: entry before reaction closed`);
    if (m >= from && m < to) violations.push(`${key}: entry inside NY block`);
    if (t.exitBarT < t.entryT) violations.push(`${key}: exit before entry`);
    if (t.risk <= 0) violations.push(`${key}: non-positive risk`);
    if (t.exitType === 'tp' && Math.abs(t.r - 2) > 1e-6) violations.push(`${key}: target not +2R (${t.r})`);
    if (t.exitType === 'stop' && Math.abs(t.r - (-1 - slipCost / t.risk)) > 1e-6) violations.push(`${key}: stop not -1R less slippage (${t.r})`);
    if (t.exitType === 'stop_gap' && t.r > -1) violations.push(`${key}: gap stop better than -1R (${t.r})`);
    if (trades.filter(x => x.entryT <= t.entryT && x.availT > t.entryT).length > 2) violations.push(`${key}: more than 2 open`);
    const side = t.side === 'long' ? 1 : -1;
    if (side * (t.fill - t.stop) <= 0 || side * (t.tp - t.fill) <= 0) violations.push(`${key}: bad stop or target geometry`);
    void spreadCost; void secs;
  }
}

// --- Lookahead check: cut all data at a date. Trades that finished before the cut must be identical. ---
const lookahead = [];
for (const cutIso of ['2026-09-15T00:00:00Z', '2026-10-01T00:00:00Z', '2026-10-20T00:00:00Z', '2026-10-27T00:00:00Z']) {
  const cut = Date.parse(cutIso) / 1000;
  const cutData = prepare({
    m3: base.m3.filter(b => b.t + SECS.m3 <= cut), m15: base.m15.filter(b => b.t + SECS.m15 <= cut), h1: base.h1.filter(b => b.t + SECS.h1 <= cut),
  });
  for (const [label, stage] of Object.entries(STAGES)) {
    if (stage.fromT && cut <= m3Start) continue;
    if (label === 'C' && cutData.m3.length < 50) continue;
    for (const keepBand of [true, false]) {
      const opts = { ...stage, keepBand, spread: 0.4, slip: 0.1 };
      const full = runStage(d, opts).trades.filter(t => t.availT <= cut - 86400);
      const cutTrades = runStage(cutData, opts).trades.filter(t => t.availT <= cut - 86400);
      const same = JSON.stringify(full) === JSON.stringify(cutTrades);
      lookahead.push({ cut: cutIso.slice(0, 10), stage: label, band: keepBand ? 'keep' : 'drop', compared: full.length, identical: same });
    }
  }
}

results.violations = violations.length;
results.violation_sample = violations.slice(0, 10);
results.lookahead = lookahead;

// Month split for Stage B at zero cost and at a mid-grid cost.
const monthSplit = {};
for (const band of ['keep', 'drop']) for (const cost of ['zero', 'spread 0.40']) {
  const trades = allTrades[`B|${band}|09:30|filter|${cost}`];
  const months = {};
  for (const t of trades) { const m = new Date(t.entryT * 1000).toISOString().slice(0, 7); (months[m] ||= []).push(t); }
  monthSplit[`${band}|${cost}`] = Object.fromEntries(Object.entries(months).map(([m, ts]) => { const s = summarize(ts); return [m, { trades: s.trades, win_rate: s.win_rate, total_r: s.total_r }]; }));
}
results.month_split = monthSplit;

writeFileSync(join(OUT, 'bt_results.json'), JSON.stringify(results, null, 1));
const csvHeader = 'side,reaction_utc,entry_utc,fill,stop,tp,risk,atr,exit,exit_type,exit_bar_utc,r\n';
const iso = t => new Date(t * 1000).toISOString();
for (const [name, key] of [['bt_trades_B_keep_zero.csv', 'B|keep|09:30|filter|zero'], ['bt_trades_C_keep_zero.csv', 'C|keep|09:30|filter|zero'], ['bt_trades_B_drop_zero.csv', 'B|drop|09:30|filter|zero'], ['bt_trades_C_drop_zero.csv', 'C|drop|09:30|filter|zero']]) {
  writeFileSync(join(OUT, name), csvHeader + allTrades[key].map(t => [t.side, iso(t.reactionT), iso(t.entryT), t.fill, t.stop, t.tp, t.risk, t.atr, t.exit, t.exitType, iso(t.exitBarT), t.r].join(',')).join('\n') + '\n');
}

// --- Compact output ---
const f = (v, n = 2) => (v === null || v === undefined ? 'n/a' : v.toFixed(n));
const row = r => `${r.cost.padEnd(17)} n=${String(r.trades).padStart(3)}${r.insufficient ? '*' : ' '} win=${f(r.win_rate === null ? null : r.win_rate * 100, 1).padStart(5)}% avg=${f(r.avg_r, 3).padStart(7)} ci=[${r.avg_r_ci95 ? f(r.avg_r_ci95[0]) + ',' + f(r.avg_r_ci95[1]) : 'n/a'}] tot=${f(r.total_r, 1).padStart(6)} pf=${f(r.profit_factor).padStart(5)} dd=${f(r.max_dd_r, 1).padStart(5)} streak=${String(r.longest_losing_streak).padStart(2)} L=${r.long.n}/${f(r.long.r, 1)} S=${r.short.n}/${f(r.short.r, 1)} risk=${f(r.median_risk)} ${JSON.stringify(r.exits)}`;
const show = (stage, band, nyBlock, filter, costs) => {
  console.log(`\n### ${stage} band=${band} ny=${nyBlock} ${filter ? 'WITH 1H FILTER' : 'BASELINE no filter'}`);
  for (const r of results.runs) if (r.stage === stage && r.band === band && r.ny === nyBlock && r.filter === filter && (!costs || costs.includes(r.cost))) console.log(row(r));
};
console.log('VIOLATIONS', violations.length, violations.slice(0, 5));
console.log('LOOKAHEAD', lookahead.length, 'checks, all identical:', lookahead.every(x => x.identical), 'trades compared:', lookahead.reduce((s, x) => s + x.compared, 0));
if (!lookahead.every(x => x.identical)) console.log(lookahead.filter(x => !x.identical));
console.log('RUNS', results.runs.length);
console.log('\n=== STAGE A');
for (const band of ['keep', 'drop']) for (const [h, v] of Object.entries(results.stageA[band])) {
  const g = x => `n=${x.n} mean=${f(x.mean_pct, 3)}% hit=${f(x.hit_rate * 100, 1)}% distinct=${x.distinct_n} dmean=${f(x.distinct_mean_pct, 3)}% t=${f(x.t_stat)}`;
  console.log(`${band} ${h} | ALL-UP ${g(v.all_bars_up)} | LONG ${g(v.long)} | SHORT ${g(v.short)} | none=${v.no_direction}`);
}
for (const s of ['B', 'B2', 'C']) {
  show(s, 'keep', '09:30', true);
  show(s, 'keep', '09:30', false, ['zero', 'spread 0.40', 'stress 0.80+0.25']);
  show(s, 'keep', '08:20', true, ['zero', 'spread 0.40', 'stress 0.80+0.25']);
  show(s, 'drop', '09:30', true);
  show(s, 'drop', '09:30', false, ['zero', 'spread 0.40', 'stress 0.80+0.25']);
  show(s, 'drop', '08:20', true, ['zero', 'spread 0.40', 'stress 0.80+0.25']);
}
console.log('\n=== SKIP COUNTS (zero cost, 09:30)');
for (const s of ['B', 'C']) for (const band of ['keep', 'drop']) {
  const r = results.runs.find(x => x.key === `${s}|${band}|09:30|filter|zero`);
  console.log(s, band, JSON.stringify(r.counts));
}
console.log('\n=== MONTHS (Stage B, 09:30)');
console.log(JSON.stringify(monthSplit));
