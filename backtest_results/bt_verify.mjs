// Independent read-back: re-traces exported trades against the raw CSVs without using bt_lib.mjs.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2];
const rows = p => { const [h, ...r] = readFileSync(p, 'utf8').trim().split(/\r?\n/); const k = h.split(','); return r.map(l => Object.fromEntries(l.split(',').map((v, i) => [k[i], v]))); };

const res = JSON.parse(readFileSync(join(here, 'bt_results.json'), 'utf8'));
const withTrades = res.runs.filter(r => r.trades > 0);
const excludesZero = withTrades.filter(r => r.avg_r_ci95 && (r.avg_r_ci95[0] > 0 || r.avg_r_ci95[1] < 0));
console.log('RUNS', res.runs.length, 'with trades', withTrades.length, 'CI excludes zero:', excludesZero.length);
for (const r of excludesZero) console.log('  ', r.key, 'avg', r.avg_r.toFixed(3), 'ci', r.avg_r_ci95.map(x => x.toFixed(3)).join(','));
const main = res.runs.filter(r => r.band === 'keep' && r.ny === '09:30' && r.filter);
console.log('MAIN runs', main.length, 'positive avg:', main.filter(r => r.avg_r > 0).length);
for (const s of ['B', 'B2', 'C']) console.log(' ', s, 'positive at:', main.filter(r => r.stage === s && r.avg_r > 0).map(r => r.cost).join('; ') || 'none');
console.log('Insufficient samples:', res.runs.filter(r => r.insufficient).map(r => r.key).length, 'of', res.runs.length);

for (const [file, tf] of [['bt_trades_B_keep_zero.csv', '15m'], ['bt_trades_C_keep_zero.csv', '3m'], ['bt_trades_B_drop_zero.csv', '15m'], ['bt_trades_C_drop_zero.csv', '3m']]) {
  const raw = rows(join(dir, `OANDA_XAUUSD_${tf}.csv`));
  const byTime = new Map(raw.map((b, i) => [b.time_utc, i]));
  const m15 = rows(join(dir, 'OANDA_XAUUSD_15m.csv'));
  const m15ByTime = new Map(m15.map(b => [b.time_utc, b]));
  let ok = 0, bad = [];
  for (const t of rows(join(here, file))) {
    const long = t.side === 'long';
    const i = byTime.get(t.entry_utc);
    if (i === undefined) { bad.push(`${t.entry_utc} entry bar missing`); continue; }
    if (Math.abs(+raw[i].open - +t.fill) > 1e-9) { bad.push(`${t.entry_utc} fill != open`); continue; }
    // The reaction bar opened 15 minutes before the reaction time.
    const rBar = m15ByTime.get(new Date(Date.parse(t.reaction_utc) - 900000).toISOString());
    const expStop = long ? +rBar.low - 0.1 * +t.atr : +rBar.high + 0.1 * +t.atr;
    if (Math.abs(expStop - +t.stop) > 1e-9) { bad.push(`${t.entry_utc} stop mismatch`); continue; }
    if (Math.abs(Math.abs(+t.tp - +t.fill) - 2 * Math.abs(+t.fill - +t.stop)) > 1e-9) { bad.push(`${t.entry_utc} target not 2R`); continue; }
    let type = null, at = null;
    for (let k = i; k < raw.length && !type; k++) {
      const [o, h, l] = [+raw[k].open, +raw[k].high, +raw[k].low];
      const hitStop = long ? l <= +t.stop : h >= +t.stop;
      const hitTp = long ? h >= +t.tp : l <= +t.tp;
      if (hitStop) { type = (long ? o <= +t.stop : o >= +t.stop) ? 'stop_gap' : 'stop'; at = raw[k].time_utc; }
      else if (hitTp) { type = 'tp'; at = raw[k].time_utc; }
      else if (raw[k].time_utc === t.exit_bar_utc && t.exit_type === 'friday') { type = 'friday'; at = raw[k].time_utc; }
    }
    if (type === t.exit_type && at === t.exit_bar_utc) ok++;
    else bad.push(`${t.entry_utc} ${t.exit_type}@${t.exit_bar_utc} vs traced ${type}@${at}`);
  }
  console.log(file, 'traced OK:', ok, 'mismatches:', bad.length, bad.slice(0, 5));
}
