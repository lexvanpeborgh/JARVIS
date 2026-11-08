import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { prepareSeries, evaluate } from '../src/core/evaluate.js';
import { getStrategy, STRATEGIES, DEFAULT_STRATEGY } from '../src/core/strategies/index.js';
import { getInstrument } from '../src/core/instruments.js';
import { syntheticCandles } from '../src/data/providers/demo.js';
import { runBacktest } from '../src/backtest/engine.js';
import { openDb, upsertCandles } from '../src/store/db.js';
import { secretStore } from '../src/server/security.js';
import { createEngine } from '../src/engine/engine.js';
import { createApp } from '../src/server/http.js';

const eu = getInstrument('EUR_USD');
const win = getStrategy('EMA_RSI_WINDOW');

test('EMA_RSI_WINDOW is een aparte versie; legacy ongewijzigd', () => {
  assert.equal(DEFAULT_STRATEGY, 'EMA_RSI_WINDOW');
  assert.equal(STRATEGIES.LEGACY_EMA_RSI_VOL.version, '1.0.0');
  assert.equal(STRATEGIES.LEGACY_EMA_RSI_VOL.params.slAtr, 2);
  assert.equal(STRATEGIES.LEGACY_EMA_RSI_VOL.params.rsiWindow, undefined);
});

test('EMA_RSI_WINDOW: signalen met RSI-extreem binnen venster, nominale RR 2,0, causaal', () => {
  const c = syntheticCandles('EUR_USD', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 6, 5));
  const r = runBacktest({ candles: c, inst: eu, strategy: win });
  const fired = r.decisions.filter(d => d.state === 'BUY' || d.state === 'SELL');
  assert.ok(fired.length > 0, 'verwacht signalen');
  const s = prepareSeries(c, eu, 'M5', win);
  for (const d of fired.slice(0, 5)) {
    const i = d.index;
    const rsis = s.ind.rsi.slice(i - 9, i + 1);
    if (d.direction === 'LONG') assert.ok(Math.min(...rsis) < 30); else assert.ok(Math.max(...rsis) > 70);
    const rr = Math.abs(d.tp2 - d.entryRef) / Math.abs(d.entryRef - d.sl);
    assert.ok(rr <= 2 + 1e-9 && rr > 1.9, `rr ${rr} (na conservatieve tickafronding)`);
    const cut = prepareSeries(c.slice(0, i + 1), eu, 'M5', win);
    const env = { mode: 'backtest', now: c[i].t + 300_000, quote: { bid: c[i].b.c, ask: c[i].a.c, time: c[i].t + 300_000 }, newsMode: 'off' };
    assert.equal(evaluate(cut, i, win, env).state, evaluate(s, i, win, env).state);
  }
});

function loginLessRequest(port, host, path = '/api/session') {
  return new Promise((res, rej) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, r => { let b = ''; r.on('data', x => { b += x; }); r.on('end', () => res({ status: r.statusCode, body: JSON.parse(b || '{}'), cookie: r.headers['set-cookie']?.[0] })); });
    req.on('error', rej); req.end();
  });
}

test('lokale app: automatisch aangemeld via loopback, geweigerd bij vreemde Host (DNS-rebinding) en zonder lokale modus', async () => {
  const db = openDb(':memory:'); const secrets = secretStore(db, randomBytes(32));
  const log = { info() {}, warn() {}, error() {} };
  const engine = createEngine({ db, secrets, autoStart: false, log });
  const { server } = createApp({ db, engine, secrets, env: { FNX_LOCAL_APP: '1', FNX_HOST: '127.0.0.1' }, log });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const ok = await loginLessRequest(port, `127.0.0.1:${port}`);
    assert.equal(ok.body.authenticated, true); assert.equal(ok.body.localApp, true); assert.match(ok.cookie, /HttpOnly; SameSite=Strict/);
    const evil = await loginLessRequest(port, `evil.example:${port}`);
    assert.equal(evil.body.authenticated, false);
  } finally { server.close(); }
  const { server: s2 } = createApp({ db, engine, secrets, env: { FNX_ACCESS_PASSWORD: 'x' }, log });
  await new Promise(r => s2.listen(0, '127.0.0.1', r));
  try { assert.equal((await loginLessRequest(s2.address().port, `127.0.0.1:${s2.address().port}`)).body.authenticated, false); } finally { s2.close(); }
});

test('papertrading-ticket: vult op ask/bid, papersaldo bepaalt grootte, weigert bij gesloten markt of oude quote', () => {
  const db = openDb(':memory:'); const secrets = secretStore(db, randomBytes(32));
  let NOW = Date.UTC(2026, 0, 13, 10, 0, 3); // dinsdag
  const engine = createEngine({ db, secrets, autoStart: false, clock: () => NOW, log: { info() {}, warn() {}, error() {} } });
  engine.hub.connected = true; engine.hub.mode = 'stream';
  engine.hub.update({ instrument: 'EUR_USD', bid: 1.10000, ask: 1.10008, time: NOW - 500, receivedAt: NOW - 400, source: 'test', kind: 'real' });
  const r = engine.openManualPaper({ instrument: 'EUR_USD', direction: 'LONG', sl: 1.0990, tp: 1.1020 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(Math.abs(r.fill - (1.10008 + 0.2 * 0.0001)) < 1e-9);
  // 1% van 10.000 EUR; EUR/USD-quote → pipwaarde in EUR via koers
  assert.ok(r.units > 0);
  const sum = engine.paperSummary();
  assert.equal(sum.start, 10000); assert.equal(sum.currency, 'EUR');
  // SL geraakt → gesloten met verlies, saldo daalt
  engine.hub.update({ instrument: 'EUR_USD', bid: 1.0989, ask: 1.09898, time: NOW + 1000, receivedAt: NOW + 1000, source: 'test', kind: 'real' });
  NOW += 2000;
  // monitorPaper wordt via onQuote aangeroepen; hier rechtstreeks sluiten via de engine-API
  const pos = db.get("SELECT * FROM paper_positions WHERE status = 'OPEN'");
  engine.closePaper(pos.id, 1.0989, 'SL');
  assert.ok(engine.paperSummary().balance < 10000);
  // weekend → geweigerd
  NOW = Date.UTC(2026, 0, 17, 12);
  assert.equal(engine.openManualPaper({ instrument: 'EUR_USD', direction: 'SHORT', sl: 1.11, tp: 1.09 }).code, 'MARKET_CLOSED');
  // oude quote → geweigerd
  NOW = Date.UTC(2026, 0, 13, 11);
  engine.hub.heartbeatReceivedAt = NOW - 60_000;
  assert.equal(engine.openManualPaper({ instrument: 'EUR_USD', direction: 'SHORT', sl: 1.11, tp: 1.09 }).code, 'QUOTE_STALE');
  assert.equal(db.get("SELECT COUNT(*) n FROM paper_orders WHERE status = 'REJECTED'").n, 2);
});

test('grafiek-API levert causale historische signalen en paperposities', async () => {
  const { chartData } = await import('../src/server/services.js');
  const db = openDb(':memory:');
  const c = syntheticCandles('USD_JPY', 'M5', Date.UTC(2026, 0, 5), Date.UTC(2026, 1, 20));
  upsertCandles(db, 'live:demo', 'USD_JPY', 'M5', c);
  const d = chartData(db, { instrument: 'USD_JPY', tf: 'M5', strategyId: 'EMA_RSI_WINDOW', limit: 3000 });
  assert.ok(Array.isArray(d.history) && d.history.length > 0);
  for (const h of d.history) assert.ok(h.entryRef == null || h.entryRef > 0);
  assert.ok(Array.isArray(d.paper));
});
