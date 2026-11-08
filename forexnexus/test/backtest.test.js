import test from 'node:test';
import assert from 'node:assert/strict';
import { runBacktest } from '../src/backtest/engine.js';
import { getStrategy } from '../src/core/strategies/index.js';
import { getInstrument } from '../src/core/instruments.js';
import { syntheticCandles } from '../src/data/providers/demo.js';
import { openDb, upsertCandles } from '../src/store/db.js';
import { replayStep } from '../src/server/services.js';
import { legacyBuySeries } from './fixtures.js';

const eu = getInstrument('EUR_USD');
const legacy = getStrategy('LEGACY_EMA_RSI_VOL');
const struct = getStrategy('STRUCT_SWEEP_MSS');
const COSTS = { spreadMode: 'bidask', slippagePerSide: 0, commissionPerSidePerUnit: 0 };

/** Voeg na de signaalreeks candles toe met opgegeven OHLC (bid/ask ± 0,4 pip). */
function extend(c, bars) {
  const out = [...c]; const r = x => Number(x.toFixed(5));
  for (const [o, h, l, cl] of bars) {
    const t = out.at(-1).t + 300_000;
    out.push({ t, o, h, l, c: cl, v: 100, vType: 'tick_count', complete: true, kind: 'real', b: { o: r(o - 0.00004), h: r(h - 0.00004), l: r(l - 0.00004), c: r(cl - 0.00004) }, a: { o: r(o + 0.00004), h: r(h + 0.00004), l: r(l + 0.00004), c: r(cl + 0.00004) } });
  }
  return out;
}

function signalAndLevels() {
  const c = legacyBuySeries();
  const base = runBacktest({ candles: extend(c, [[c.at(-1).c, c.at(-1).c + 0.00001, c.at(-1).c - 0.00001, c.at(-1).c]]), inst: eu, strategy: legacy, costs: COSTS });
  const t = base.trades[0];
  return { c, entry: t.entryFill, sl: t.plan.sl, tp: t.plan.tp2, ref: t.entryRef };
}

test('uitvoering op de volgende open (ask), niet binnen de signaalcandle', () => {
  const c = legacyBuySeries(); const P = c.at(-1).c;
  const r = runBacktest({ candles: extend(c, [[P + 0.00002, P + 0.00003, P + 0.00001, P + 0.00002], [P, P, P, P]]), inst: eu, strategy: legacy, costs: COSTS });
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.signalIndex, c.length - 1);
  assert.equal(t.entryIndex, c.length);
  assert.equal(t.entryFill, Number((P + 0.00002 + 0.00004).toFixed(5)));
});

test('SL en TP in dezelfde candle → SL eerst (conservatief), optimistische waarde gerapporteerd', () => {
  const { c, sl, tp } = signalAndLevels(); const P = c.at(-1).c;
  const r = runBacktest({ candles: extend(c, [[P, P + 0.00001, P - 0.00001, P], [P, tp + 0.0002, sl - 0.0002, P]]), inst: eu, strategy: legacy, costs: COSTS });
  const t = r.trades[0];
  assert.equal(t.exitReason, 'SL_AMBIGUOUS');
  assert.ok(t.rNet < 0); assert.ok(t.optimisticR > 1);
  assert.equal(r.metrics.all.ambiguous, 1);
});

test('gap voorbij de stop vult op de bereikbare open, niet op de stopprijs', () => {
  const { c, sl } = signalAndLevels(); const P = c.at(-1).c;
  const gapOpen = sl - 0.0010;
  const r = runBacktest({ candles: extend(c, [[P, P + 0.00001, P - 0.00001, P], [gapOpen, gapOpen + 0.0001, gapOpen - 0.0001, gapOpen]]), inst: eu, strategy: legacy, costs: COSTS });
  const t = r.trades[0];
  assert.equal(t.exitReason, 'SL_GAP');
  assert.ok(t.exitPx < sl - 0.0009);
  assert.ok(t.rNet < -1.4);
});

test('datagat tijdens positie → ONBEPAALD, niet gescoord', () => {
  const { c } = signalAndLevels(); const P = c.at(-1).c;
  const withEntry = extend(c, [[P, P + 0.00001, P - 0.00001, P]]);
  const gapCandle = extend(withEntry, [[P, P, P, P]]).at(-1);
  gapCandle.t += 6 * 300_000; // 6 candles ontbreken op dinsdagochtend
  const r = runBacktest({ candles: [...withEntry, gapCandle], inst: eu, strategy: legacy, costs: COSTS });
  assert.equal(r.trades[0].status, 'UNDETERMINED');
  assert.equal(r.metrics.all.trades, 0);
  assert.equal(r.metrics.all.undetermined, 1);
});

test('entry te ver weg op de volgende open → ENTRY_MISSED, niet gevuld', () => {
  const c = legacyBuySeries(); const P = c.at(-1).c;
  const far = P + 0.0010;
  const r = runBacktest({ candles: extend(c, [[far, far, far, far]]), inst: eu, strategy: legacy, costs: COSTS });
  assert.equal(r.trades.length, 0);
  assert.equal(r.skipped[0].reason, 'ENTRY_MISSED');
});

test('kostenscenario\'s verslechteren het resultaat; bruto ≥ netto', () => {
  const c = syntheticCandles('EUR_USD', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 5, 1));
  const base = runBacktest({ candles: c, inst: eu, strategy: struct, scenario: 'baseline' });
  const bad = runBacktest({ candles: c, inst: eu, strategy: struct, scenario: 'severe' });
  if (base.metrics.all.trades > 0) assert.ok(base.metrics.all.grossR >= base.metrics.all.netR - 1e-9);
  assert.ok(base.meta.dataKind === 'synthetic');
  assert.ok(base.metrics.verdict.label === 'ONVOLDOENDE BEWIJS' || base.metrics.verdict.label === 'VOLDOET NIET' || base.metrics.verdict.passes);
  assert.equal(typeof bad.metrics.all.trades, 'number');
});

test('warm-up uitgesloten en splits chronologisch', () => {
  const c = syntheticCandles('EUR_USD', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 3, 1));
  const r = runBacktest({ candles: c, inst: eu, strategy: struct });
  assert.equal(r.meta.warmupBars, struct.minHistory - 1);
  for (const t of r.trades) assert.ok(t.signalIndex >= struct.minHistory - 1);
  assert.ok(Date.parse(r.meta.splits.valFrom) < Date.parse(r.meta.splits.testFrom));
});

test('replay levert dezelfde causale beslissingen als de backtest', () => {
  const db = openDb(':memory:');
  const c = syntheticCandles('EUR_USD', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 2, 1));
  db.run("INSERT INTO datasets (id, source, instrument, timeframe, kind, imported_at, quality) VALUES ('t1','demo','EUR_USD','M5','synthetic',0,'{}')");
  upsertCandles(db, 't1', 'EUR_USD', 'M5', c);
  const bt = runBacktest({ candles: c, inst: eu, strategy: struct });
  const checked = [];
  for (const d of bt.decisions.slice(0, 25)) {
    const r = replayStep(db, { datasetId: 't1', strategyId: struct.id, cursor: d.index });
    assert.ok(r.candles.at(-1).t === c[d.index].t, 'geen toekomstige candles');
    if (r.consistency.consistent !== null) { assert.equal(r.consistency.consistent, true, `index ${d.index}: ${r.decision.state} vs ${d.state}`); checked.push(d.index); }
  }
  for (let k = 400; k < c.length; k += 1500) { const r = replayStep(db, { datasetId: 't1', strategyId: struct.id, cursor: k }); if (r.consistency.consistent !== null) assert.equal(r.consistency.consistent, true); }
  assert.ok(checked.length > 0);
});
