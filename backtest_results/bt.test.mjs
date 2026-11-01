// Hand-checked tests for the offline backtest engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ema, rsi, atr, ny, tradingDay, inNyBlock, fridayCloseFlags, direction, lastClosedIndex,
  entryFill, simulateExit, summarize, prepare, runStage, SECS,
} from './bt_lib.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const utc = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 1000;
const bar = (t, o, h, l, c) => ({ t, o, h, l, c });
const closes = a => a.map((c, i) => bar(i, c, c, c, c));

test('EMA: seeded with SMA, then standard smoothing', () => {
  const e = ema(closes([1, 2, 3, 4]), 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  near(e[2], 2);       // (1+2+3)/3
  near(e[3], 3);       // 4*0.5 + 2*0.5
});

test('RSI: all gains = 100, all losses = 0, Wilder values by hand', () => {
  assert.equal(rsi(closes([1, 2, 3, 4]), 3)[3], 100);
  assert.equal(rsi(closes([4, 3, 2, 1]), 3)[3], 0);
  // changes +2,-1,+2 -> avg gain 4/3, avg loss 1/3 -> RS 4 -> RSI 80
  const r = rsi(closes([10, 12, 11, 13, 12]), 3);
  near(r[3], 80);
  // next change -1: gain (4/3*2)/3 = 8/9, loss (1/3*2+1)/3 = 5/9 -> RS 1.6 -> 61.538...
  near(r[4], 100 - 100 / (1 + 1.6));
});

test('ATR: true range uses the previous close, then Wilder smoothing', () => {
  const b = [bar(0, 10, 11, 9, 10), bar(1, 10, 12, 10, 11), bar(2, 11, 15, 14, 14)];
  const a = atr(b, 2);
  near(a[1], 2);                      // TRs 2, 2
  near(a[2], (2 * 1 + 4) / 2);        // TR = max(1, |15-11|, |14-11|) = 4
});

test('New York clock follows daylight saving', () => {
  assert.equal(ny(utc('2026-07-15 13:30')).minutes, 9 * 60 + 30);   // EDT
  assert.equal(ny(utc('2026-01-15 14:30')).minutes, 9 * 60 + 30);   // EST
});

test('NY open blocks cover exactly 15 minutes', () => {
  assert.equal(inNyBlock(utc('2026-10-14 13:29'), '09:30'), false);
  assert.equal(inNyBlock(utc('2026-10-14 13:30'), '09:30'), true);
  assert.equal(inNyBlock(utc('2026-10-14 13:42'), '09:30'), true);
  assert.equal(inNyBlock(utc('2026-10-14 13:45'), '09:30'), false);
  assert.equal(inNyBlock(utc('2026-10-14 12:20'), '08:20'), true);
  assert.equal(inNyBlock(utc('2026-10-14 13:30'), '08:20'), false);
});

test('Trading day resets at 18:00 New York', () => {
  assert.equal(tradingDay(utc('2026-10-14 21:59')), '2026-10-14'); // 17:59 NY
  assert.equal(tradingDay(utc('2026-10-14 22:00')), '2026-10-15'); // 18:00 NY
});

test('Friday close: flags the last bar only, including at the end of the data', () => {
  const b = [
    bar(utc('2026-10-23 20:30'), 1, 1, 1, 1), bar(utc('2026-10-23 20:45'), 1, 1, 1, 1),
    bar(utc('2026-10-25 22:00'), 1, 1, 1, 1), bar(utc('2026-10-30 20:45'), 1, 1, 1, 1),
  ];
  assert.deepEqual(fridayCloseFlags(b, 900), [false, true, false, true]);
});

test('1H direction, with and without the RSI band', () => {
  assert.equal(direction(101, 100, 58, true), 'long');
  assert.equal(direction(101, 100, 50, true), null);
  assert.equal(direction(101, 100, 50, false), 'long');
  assert.equal(direction(101, 100, 60, true), null);
  assert.equal(direction(99, 100, 42, true), 'short');
  assert.equal(direction(99, 100, 50, false), 'short');
  assert.equal(direction(99, 100, 40, false), null);
  assert.equal(direction(100, 100, 50, false), null);
});

test('No lookahead: a 1H bar is unusable until it has closed', () => {
  const b = [{ t: 3600 }, { t: 7200 }];
  assert.equal(lastClosedIndex(b, 3600, 7199), -1);
  assert.equal(lastClosedIndex(b, 3600, 7200), 0);
  assert.equal(lastClosedIndex(b, 3600, 10799), 0);
  assert.equal(lastClosedIndex(b, 3600, 10800), 1);
  assert.equal(lastClosedIndex(b, 3600, 3600), -1);
});

test('Fills: spread and slippage always hurt', () => {
  near(entryFill('long', 100, 0.4, 0.1), 100.3);
  near(entryFill('short', 100, 0.4, 0.1), 99.7);
});

const flat = (...b) => b.map((x, i) => ({ t: i, ...x }));
const noFlags = n => new Array(n).fill(false);

test('Long exits: take-profit, stop, and stop wins a same-bar conflict', () => {
  const tp = flat({ o: 100, h: 104, l: 99.5, c: 103 });
  assert.equal(simulateExit('long', tp, noFlags(1), 0, 99, 102, 0, 0).type, 'tp');
  near(simulateExit('long', tp, noFlags(1), 0, 99, 102, 0, 0).exit, 102);
  const st = flat({ o: 100, h: 100.5, l: 98, c: 99 });
  assert.equal(simulateExit('long', st, noFlags(1), 0, 99, 102, 0, 0).type, 'stop');
  const both = flat({ o: 100, h: 104, l: 98, c: 103 });
  assert.equal(simulateExit('long', both, noFlags(1), 0, 99, 102, 0, 0).type, 'stop');
});

test('Short exits mirror long exits', () => {
  const tp = flat({ o: 100, h: 100.5, l: 96, c: 97 });
  assert.equal(simulateExit('short', tp, noFlags(1), 0, 101, 98, 0, 0).type, 'tp');
  const st = flat({ o: 100, h: 102, l: 99, c: 101 });
  assert.equal(simulateExit('short', st, noFlags(1), 0, 101, 98, 0, 0).type, 'stop');
  const both = flat({ o: 100, h: 102, l: 96, c: 97 });
  assert.equal(simulateExit('short', both, noFlags(1), 0, 101, 98, 0, 0).type, 'stop');
});

test('Gaps: a stop gapped through fills at the open, plus slippage', () => {
  const b = flat({ o: 100, h: 100.5, l: 99.5, c: 100 }, { o: 95, h: 96, l: 94, c: 95 });
  const x = simulateExit('long', b, noFlags(2), 0, 99, 102, 0, 0.1);
  assert.equal(x.type, 'stop_gap');
  near(x.exit, 94.9);
  const s = flat({ o: 100, h: 100.5, l: 99.5, c: 100 }, { o: 105, h: 106, l: 104, c: 105 });
  near(simulateExit('short', s, noFlags(2), 0, 101, 98, 0, 0.1).exit, 105.1);
});

test('Spread: triggers use the exit side; take-profit gets no slippage', () => {
  // Long exits on the bid (mid - 0.5). High of 102.4 gives a bid of 101.9, so no target hit at 102.
  const miss = flat({ o: 100, h: 102.4, l: 99.8, c: 102 });
  assert.equal(simulateExit('long', miss, noFlags(1), 0, 99, 102, 1, 0), null);
  const hit = flat({ o: 100, h: 102.5, l: 99.8, c: 102 });
  near(simulateExit('long', hit, noFlags(1), 0, 99, 102, 1, 0.25).exit, 102);
  // Low of 99.4 gives a bid of 98.9, through the 99 stop even though mid never touched it.
  const st = flat({ o: 100, h: 100.2, l: 99.4, c: 100 });
  const x = simulateExit('long', st, noFlags(1), 0, 99, 102, 1, 0.25);
  assert.equal(x.type, 'stop');
  near(x.exit, 98.75);
});

test('Friday close: exits at the close on the exit side, after stop and target checks', () => {
  const b = flat({ o: 100, h: 101, l: 99.5, c: 100.5 });
  const x = simulateExit('long', b, [true], 0, 99, 105, 0.4, 0.1);
  assert.equal(x.type, 'friday');
  near(x.exit, 100.5 - 0.2 - 0.1);
  assert.equal(simulateExit('long', b, [true], 0, 99.8, 105, 0, 0).type, 'stop');
});

test('Summary: win rate, profit factor, drawdown and streak by hand', () => {
  const mk = (r, i, side = 'long') => ({ r, side, availT: i, entryT: i, exitType: 'tp', risk: 1 });
  const s = summarize([mk(2, 1), mk(-1, 2), mk(-1, 3, 'short'), mk(2, 4)]);
  assert.equal(s.trades, 4);
  near(s.win_rate, 0.5);
  near(s.total_r, 2);
  near(s.avg_r, 0.5);
  near(s.profit_factor, 2);
  near(s.max_dd_r, 2);
  assert.equal(s.longest_losing_streak, 2);
  assert.equal(s.short.n, 1);
  assert.equal(s.insufficient, true);
});

// --- A small market for the full pipeline. Monday Oct 19, 2026, away from any NY-open block unless stated. ---
function market({ startUtc, reactions, after }) {
  // 60 quiet 15M bars at 100, then scripted bars. EMA(20) stays at 100 during the quiet stretch.
  const s = utc(startUtc);
  const m15 = [];
  for (let i = 0; i < 60; i++) m15.push(bar(s + i * 900, 100, 100.2, 99.8, 100));
  const scripted = [...reactions, ...after];
  scripted.forEach((b, k) => m15.push(bar(s + (60 + k) * 900, ...b)));
  const h1 = [];
  for (let i = 0; i < 40; i++) {
    const t = s - (40 - i) * 3600;
    // Slow rise with alternating bars: the last close sits above EMA(20) and RSI(14) is about 54.
    const c = 90 + i * 0.1 + (i % 2 ? 0.6 : -0.6);
    h1.push(bar(t, c, c + 0.5, c - 0.5, c));
  }
  return prepare({ m15, h1, m3: null });
}

test('Pipeline: reaction enters at the next 15M open, with stop = low - 0.1 x ATR and 2R target', () => {
  const d = market({
    startUtc: '2026-10-19 00:00',
    reactions: [[100, 100.3, 99.7, 100.2]], // low under EMA, close above: long reaction
    after: [[100.2, 100.4, 100.1, 100.3], [100.3, 104, 100.2, 103.5]],
  });
  const { trades } = runStage(d, { stage: 'B', keepBand: false });
  const longs = trades.filter(t => t.reactionT === d.m15[60].t + 900);
  assert.equal(longs.length, 1);
  const t = longs[0];
  assert.equal(t.entryT, d.m15[61].t);
  near(t.fill, 100.2);
  near(t.stop, 99.7 - 0.1 * t.atr);
  near(t.tp, t.fill + 2 * (t.fill - t.stop));
  assert.equal(t.exitType, 'tp');
  near(t.r, 2);
});

test('Pipeline: the 1H filter removes a reaction against the direction', () => {
  const d = market({
    startUtc: '2026-10-19 00:00',
    reactions: [[100, 100.3, 99.9, 99.95]], // high over EMA, close below: short reaction, 1H is rising
    after: [[99.95, 100, 99.9, 99.95], [99.95, 100, 90, 91]],
  });
  const filtered = runStage(d, { stage: 'B', keepBand: false });
  const shortT = d.m15[60].t + 900;
  assert.equal(filtered.trades.filter(t => t.reactionT === shortT).length, 0);
  const baseline = runStage(d, { stage: 'B', keepBand: false, useFilter: false });
  assert.equal(baseline.trades.filter(t => t.reactionT === shortT).length, 1);
});

test('Pipeline: an entry inside the NY-open block is skipped', () => {
  // 60 bars of 15 minutes = 15 hours, so a 22:15 start puts the reaction at 13:15 and the entry at 13:30 UTC (09:30 NY).
  const d = market({
    startUtc: '2026-10-18 22:15',
    reactions: [[100, 100.3, 99.7, 100.2]],
    after: [[100.2, 104, 100.1, 103.5]],
  });
  const main = runStage(d, { stage: 'B', keepBand: false, nyBlock: '09:30' });
  assert.equal(main.trades.filter(t => t.entryT === utc('2026-10-19 13:30')).length, 0);
  assert.ok(main.counts.ny_block >= 1);
  const alt = runStage(d, { stage: 'B', keepBand: false, nyBlock: '08:20' });
  assert.equal(alt.trades.filter(t => t.entryT === utc('2026-10-19 13:30')).length, 1);
});

// Directly scripted 15M data so the risk rules can be exercised trade by trade.
function losingSequence(n) {
  const s = utc('2026-10-19 00:00');
  const m15 = [];
  for (let i = 0; i < 60; i++) m15.push(bar(s + i * 900, 100, 100.2, 99.8, 100));
  let t = s + 60 * 900;
  for (let k = 0; k < n; k++) {
    m15.push(bar(t, 100, 100.3, 99.7, 100.2)); t += 900;  // long reaction
    m15.push(bar(t, 100.2, 100.25, 90, 95)); t += 900;    // stops the trade, closes below EMA
    for (let q = 0; q < 8; q++) {                          // recover without touching the EMA from below
      m15.push(bar(t, 95, 96, 94.9, 95)); t += 900;
    }
    m15.push(bar(t, 95, 100, 95, 99.9)); t += 900;
    for (let q = 0; q < 30; q++) { m15.push(bar(t, 100, 100.2, 99.8, 100)); t += 900; }
  }
  return { m15, s };
}

test('Risk rule: no new entries after 2 straight losses in a trading day', () => {
  const { m15 } = losingSequence(3);
  const d = prepare({ m15, h1: [], m3: null });
  const { trades, counts } = runStage(d, { stage: 'B', useFilter: false });
  const firstDayLosses = trades.filter(t => t.r < 0 && tradingDay(t.entryT) === tradingDay(trades[0].entryT));
  assert.ok(firstDayLosses.length >= 2);
  // Once two losses in a row have closed, nothing else may enter on that trading day.
  const ordered = [...trades].sort((a, b) => a.entryT - b.entryT);
  for (let i = 2; i < ordered.length; i++) {
    const [a, b, c] = [ordered[i - 2], ordered[i - 1], ordered[i]];
    const sameDay = tradingDay(a.entryT) === tradingDay(c.entryT) && tradingDay(b.entryT) === tradingDay(c.entryT);
    assert.ok(!(sameDay && a.r < 0 && b.r < 0 && b.availT <= c.entryT), 'entered after a two-loss streak');
  }
  assert.ok(counts.daily_stop >= 1);
});

test('Risk rule: never more than 2 positions open at once', () => {
  const s = utc('2026-10-19 00:00');
  const m15 = [];
  for (let i = 0; i < 60; i++) m15.push(bar(s + i * 900, 100, 100.2, 99.8, 100));
  // Repeated long reactions while earlier trades stay open with stops and targets far away.
  for (let i = 60; i < 80; i++) m15.push(bar(s + i * 900, 100, 100.3, 99.6, 100.1));
  m15.push(bar(s + 80 * 900, 100.1, 110, 100, 105)); // every open trade reaches its target here
  const d = prepare({ m15, h1: [], m3: null });
  const { trades, counts } = runStage(d, { stage: 'B', useFilter: false });
  for (const t of trades) {
    const open = trades.filter(x => x.entryT <= t.entryT && x.availT > t.entryT).length;
    assert.ok(open <= 2, `${open} open at ${t.entryT}`);
  }
  assert.ok(counts.max_positions > 0);
});

test('Stage C: enters on the 3M bar after the trigger, inside the 15-minute window only', () => {
  const s = utc('2026-10-19 00:00');
  const m15 = [];
  for (let i = 0; i < 60; i++) m15.push(bar(s + i * 900, 100, 100.2, 99.8, 100));
  m15.push(bar(s + 60 * 900, 100, 100.3, 99.7, 100.2));   // long reaction, closes at T
  const T = s + 61 * 900;
  for (let i = 61; i < 70; i++) m15.push(bar(s + i * 900, 100.2, 100.3, 100.1, 100.2));
  const m3 = [
    bar(T - 180, 100, 100.25, 100, 100.2),
    bar(T, 100.2, 100.24, 100.1, 100.2),         // close 100.2 under previous high: no trigger
    bar(T + 180, 100.2, 100.4, 100.15, 100.3),   // close 100.3 over 100.24: trigger
    bar(T + 360, 100.31, 104, 100.3, 103),       // entry at this open, target reached
    bar(T + 540, 103, 103, 103, 103),
  ];
  const d = prepare({ m15, h1: [], m3 });
  const { trades } = runStage(d, { stage: 'C', useFilter: false, fromT: m3[0].t });
  const t = trades.find(x => x.reactionT === T);
  assert.equal(t.entryT, T + 360);
  near(t.fill, 100.31);
  assert.equal(t.exitType, 'tp');
  near(t.r, 2);
});

test('Stage C: a trigger with no next bar before a closure is skipped', () => {
  const s = utc('2026-10-19 00:00');
  const m15 = [];
  for (let i = 0; i < 60; i++) m15.push(bar(s + i * 900, 100, 100.2, 99.8, 100));
  m15.push(bar(s + 60 * 900, 100, 100.3, 99.7, 100.2));
  const T = s + 61 * 900;
  m15.push(bar(T, 100.2, 100.3, 100.1, 100.2));
  const m3 = [bar(T - 180, 100, 100.1, 100, 100), bar(T, 100, 100.4, 100, 100.3), bar(T + 3600, 100, 100, 100, 100)];
  const d = prepare({ m15, h1: [], m3 });
  const { trades, counts } = runStage(d, { stage: 'C', useFilter: false, fromT: m3[0].t });
  assert.equal(trades.filter(x => x.reactionT === T).length, 0);
  assert.ok(counts.no_next_bar >= 1);
});

test('Stage C: no trigger within the window means no trade', () => {
  const s = utc('2026-10-19 00:00');
  const m15 = [];
  for (let i = 0; i < 60; i++) m15.push(bar(s + i * 900, 100, 100.2, 99.8, 100));
  m15.push(bar(s + 60 * 900, 100, 100.3, 99.7, 100.2));
  const T = s + 61 * 900;
  m15.push(bar(T, 100.2, 100.3, 100.1, 100.2));
  const m3 = [bar(T - 180, 100, 105, 100, 100)];
  for (let k = 0; k < 5; k++) m3.push(bar(T + k * 180, 100, 100.1, 99.9, 100));
  m3.push(bar(T + 900, 100, 110, 100, 109));       // would trigger, but only after the window
  m3.push(bar(T + 1080, 109, 110, 109, 109));
  const d = prepare({ m15, h1: [], m3 });
  const { trades, counts } = runStage(d, { stage: 'C', useFilter: false, fromT: m3[0].t });
  assert.equal(trades.filter(x => x.reactionT === T).length, 0);
  assert.ok(counts.no_trigger >= 1);
});
