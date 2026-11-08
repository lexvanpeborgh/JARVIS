import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSeries, evaluate, entryStillValid, signalKey } from '../src/core/evaluate.js';
import { getStrategy } from '../src/core/strategies/index.js';
import { getInstrument } from '../src/core/instruments.js';
import { syntheticCandles } from '../src/data/providers/demo.js';
import { runBacktest } from '../src/backtest/engine.js';
import { legacyBuySeries, freshCalendar } from './fixtures.js';

const eu = getInstrument('EUR_USD');
const legacy = getStrategy('LEGACY_EMA_RSI_VOL');
const struct = getStrategy('STRUCT_SWEEP_MSS');

function liveEnv(candles, extra = {}) {
  const last = candles.at(-1); const close = last.t + 300_000;
  const now = close + 3000;
  return { mode: 'live', now, quote: { bid: last.c - 0.00004, ask: last.c + 0.00004, time: now - 500 }, calendar: freshCalendar(now), ...extra };
}

test('legacy BUY op de juiste gesloten candle met exacte regels en niveaus', () => {
  const c = legacyBuySeries();
  const s = prepareSeries(c, eu, 'M5', legacy);
  const i = c.length - 1;
  const d = evaluate(s, i, legacy, liveEnv(c));
  assert.equal(d.state, 'BUY', JSON.stringify(d.blockers));
  assert.equal(d.direction, 'LONG');
  assert.equal(d.candleTime, c[i].t);
  assert.ok(d.conditions.every(x => x.ok));
  assert.ok(d.snapshot.indicators.rsi < 30);
  assert.ok(d.snapshot.indicators.emaFastPrev <= d.snapshot.indicators.emaSlowPrev);
  assert.ok(d.snapshot.indicators.emaFast > d.snapshot.indicators.emaSlow);
  const atr = d.snapshot.indicators.atr; const e = d.entryRef;
  assert.equal(e, c[i].c + 0.00004); // ask
  assert.ok(Math.abs(d.plan.sl - (e - 2 * atr)) <= eu.tick);
  assert.ok(Math.abs(d.plan.tp2 - (e + 3.5 * atr)) <= eu.tick);
  assert.ok(Math.abs(d.plan.rr.tp2.gross - 1.75) < 0.02);
  assert.ok(Math.abs(d.plan.rr.tp1.gross - 0.75) < 0.02);
  assert.equal(d.alertable, true);
  // de candle ervoor is géén signaal
  assert.notEqual(evaluate(s, i - 1, legacy, liveEnv(c.slice(0, i))).state, 'BUY');
});

test('SELL is het spiegelbeeld (entry op bid)', () => {
  const c = legacyBuySeries({ invert: true });
  const s = prepareSeries(c, eu, 'M5', legacy);
  const d = evaluate(s, c.length - 1, legacy, liveEnv(c));
  assert.equal(d.state, 'SELL', JSON.stringify(d.blockers));
  assert.equal(d.entryRef, c.at(-1).c - 0.00004);
  assert.ok(d.plan.sl > d.entryRef && d.plan.tp2 < d.entryRef);
});

test('onvolledige candle geeft geen bevestigd signaal', () => {
  const c = legacyBuySeries(); c.at(-1).complete = false;
  const d = evaluate(prepareSeries(c, eu, 'M5', legacy), c.length - 1, legacy, liveEnv(c));
  assert.equal(d.state, 'NO_TRADE');
  assert.ok(d.blockers.some(b => b.code === 'CANDLE_INCOMPLETE'));
});

test('stale quote, late evaluatie, brede spread → geen entry', () => {
  const c = legacyBuySeries(); const s = prepareSeries(c, eu, 'M5', legacy); const i = c.length - 1;
  const env = liveEnv(c);
  const stale = evaluate(s, i, legacy, { ...env, quote: { ...env.quote, time: env.now - 6000 } });
  assert.ok(stale.blockers.some(b => b.code === 'QUOTE_STALE')); assert.equal(stale.state, 'NO_TRADE');
  const late = evaluate(s, i, legacy, { ...env, now: env.now + 60_000, quote: { ...env.quote, time: env.now + 59_500 }, calendar: freshCalendar(env.now) });
  assert.ok(late.blockers.some(b => b.code === 'EVALUATION_LATE'));
  const wide = evaluate(s, i, legacy, { ...env, quote: { ...env.quote, ask: env.quote.bid + 0.0003 } });
  assert.ok(wide.blockers.some(b => b.code === 'SPREAD_TOO_WIDE_ABS'));
  const none = evaluate(s, i, legacy, { ...env, quote: null });
  assert.ok(none.blockers.some(b => b.code === 'QUOTE_MISSING'));
});

test('nieuwsblackout en ontbrekende/verouderde kalender blokkeren', () => {
  const c = legacyBuySeries(); const s = prepareSeries(c, eu, 'M5', legacy); const i = c.length - 1;
  const env = liveEnv(c);
  const bo = evaluate(s, i, legacy, { ...env, calendar: freshCalendar(env.now, [{ title: 'CPI y/y', currency: 'USD', impact: 'High', time: env.now + 10 * 60_000 }]) });
  assert.ok(bo.blockers.some(b => b.code === 'NEWS_BLACKOUT')); assert.equal(bo.state, 'NO_TRADE');
  const miss = evaluate(s, i, legacy, { ...env, calendar: null });
  assert.ok(miss.blockers.some(b => b.code === 'CALENDAR_MISSING'));
  const old = evaluate(s, i, legacy, { ...env, calendar: { ...freshCalendar(env.now), fetchedAt: env.now - 24 * 3600_000 } });
  assert.ok(old.blockers.some(b => b.code === 'CALENDAR_STALE'));
});

test('sessie, markt gesloten, duplicaat en cooldown', () => {
  const c = legacyBuySeries({ end: Date.UTC(2026, 0, 13, 13, 55) }); // 08:55 New York → binnen NY-venster
  const s = prepareSeries(c, eu, 'M5', legacy); const i = c.length - 1;
  assert.equal(evaluate(s, i, legacy, liveEnv(c)).state, 'BUY');
  const c2 = legacyBuySeries({ end: Date.UTC(2026, 0, 13, 16, 55) }); // 11:55 NY: buiten beide vensters
  const d2 = evaluate(prepareSeries(c2, eu, 'M5', legacy), c2.length - 1, legacy, liveEnv(c2));
  assert.ok(d2.blockers.some(b => b.code === 'SESSION_NOT_ALLOWED'));
  const key = signalKey(legacy, 'EUR_USD', 'M5', c[i].t, 'LONG');
  assert.ok(evaluate(s, i, legacy, { ...liveEnv(c), state: { existingKeys: new Set([key]) } }).blockers.some(b => b.code === 'DUPLICATE_SIGNAL'));
  assert.ok(evaluate(s, i, legacy, { ...liveEnv(c), state: { lastSignalTime: c[i].t - 600_000 } }).blockers.some(b => b.code === 'COOLDOWN'));
  // vrijdag 22:00 UTC = na 17:00 NY → gesloten
  const fri = legacyBuySeries({ end: Date.UTC(2026, 0, 16, 22, 5) });
  assert.ok(evaluate(prepareSeries(fri, eu, 'M5', legacy), fri.length - 1, legacy, liveEnv(fri)).blockers.some(b => b.code === 'MARKET_CLOSED'));
});

test('volume vereist: ontbrekend volume blokkeert, wordt niet verzonnen', () => {
  const c = legacyBuySeries().map(x => ({ ...x, v: null, vType: 'none' }));
  const d = evaluate(prepareSeries(c, eu, 'M5', legacy), c.length - 1, legacy, liveEnv(c));
  assert.ok(d.blockers.some(b => b.code === 'VOLUME_UNAVAILABLE'));
  assert.notEqual(d.state, 'BUY');
});

test('entry gemist wordt niet opnieuw aangeboden', () => {
  const c = legacyBuySeries(); const s = prepareSeries(c, eu, 'M5', legacy);
  const env = liveEnv(c); const d = evaluate(s, c.length - 1, legacy, env);
  const moved = { bid: d.entryRef + d.plan.maxEntryDeviation * 2, ask: d.entryRef + d.plan.maxEntryDeviation * 2 + 0.00008, time: env.now + 1000 };
  assert.equal(entryStillValid(d, moved, env.now + 1500).code, 'ENTRY_MISSED');
  assert.equal(entryStillValid(d, { ...env.quote, time: env.now + 1000 }, env.now + 1500), null);
  assert.equal(entryStillValid(d, env.quote, d.expiresAt + 1).code, 'TTL_EXPIRED');
});

test('structuurvariant: RR-eis 2,0 wijst een ongeschikte setup af', () => {
  const c = syntheticCandles('EUR_USD', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 3, 1));
  const r = runBacktest({ candles: c, inst: eu, strategy: struct });
  const rejected = r.decisions.filter(d => d.blockers.includes('RR_BELOW_MIN'));
  assert.ok(rejected.length > 0, 'verwacht minstens één afwijzing');
  for (const d of rejected) {
    assert.equal(d.state, 'NO_TRADE');
    const rr = Math.abs(d.tp1 - d.entryRef) / Math.abs(d.entryRef - d.sl);
    assert.ok(rr < 2.0 + 1e-6, `rr ${rr}`);
  }
  for (const t of r.trades) assert.ok(Math.abs(t.plan.tp1 - t.entryRef) / Math.abs(t.entryRef - t.plan.sl) >= 2.0 - 0.02);
});

test('geen look-ahead: beslissing op afgekapte reeks = beslissing op volledige reeks', () => {
  const c = syntheticCandles('EUR_USD', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 1, 20));
  for (const strat of [legacy, struct]) {
    const full = prepareSeries(c, eu, 'M5', strat);
    const idx = [];
    const r = runBacktest({ candles: c, inst: eu, strategy: strat });
    for (const d of r.decisions.slice(0, 15)) idx.push(d.index);
    for (let k = 400; k < c.length; k += 997) idx.push(k);
    for (const i of idx) {
      const cut = prepareSeries(c.slice(0, i + 1), eu, 'M5', strat);
      const q = { bid: c[i].b.c, ask: c[i].a.c, time: c[i].t + 300_000 };
      const env = { mode: 'backtest', now: c[i].t + 300_000, quote: q, newsMode: 'off' };
      const a = evaluate(full, i, strat, env); const b = evaluate(cut, i, strat, env);
      assert.equal(a.state, b.state, `${strat.id} @${i}`);
      assert.deepEqual(a.conditions.map(x => [x.id, x.ok]), b.conditions.map(x => [x.id, x.ok]));
      assert.deepEqual(a.plan?.sl ?? null, b.plan?.sl ?? null);
      assert.deepEqual(a.plan?.tp1 ?? null, b.plan?.tp1 ?? null);
    }
  }
});

test('pivot pas bruikbaar na bevestiging (knownAt = index + R)', async () => {
  const { pivots } = await import('../src/core/structure.js');
  const c = [1, 2, 5, 2, 1, 1, 1].map((h, k) => ({ t: k, h, l: h - 0.5, o: h, c: h }));
  const p = pivots(c, 2, 2);
  assert.equal(p.highs[0].index, 2);
  assert.equal(p.highs[0].knownAt, 4);
  assert.equal(pivots(c.slice(0, 4), 2, 2).highs.length, 0, 'zonder 2 candles rechts geen pivot');
});

test('demo-/synthetische data is nooit alertable', () => {
  const c = legacyBuySeries().map(x => ({ ...x, kind: 'synthetic' }));
  const d = evaluate(prepareSeries(c, eu, 'M5', legacy, { kind: 'synthetic' }), c.length - 1, legacy, { ...liveEnv(c), mode: 'demo' });
  assert.equal(d.state, 'BUY');
  assert.equal(d.alertable, false);
});
