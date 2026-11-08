// End-to-end keten met GEMOCKTE OANDA- en Telegram-endpoints (geen echte brokerverbinding):
// provider → ontvangst → opslag → indicatoren → beslissing → risk engine → signaalregister → Telegram-outbox → dashboard-API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/store/db.js';
import { secretStore } from '../src/server/security.js';
import { saveConfig } from '../src/engine/config.js';
import { createEngine } from '../src/engine/engine.js';
import { createApp } from '../src/server/http.js';
import { legacyBuySeries } from './fixtures.js';

const TG = '987654321:AAMockTokenOnlyForEndToEndTests_xyz';

test('volledige keten: gesloten candle → BUY → signaal → één Telegram-melding → zichtbaar in API', async () => {
  const candles = legacyBuySeries();
  const last = candles.at(-1);
  const NOW = last.t + 300_000 + 3000;
  const clock = () => NOW;
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/pricing/stream')) {
      const body = new ReadableStream({
        start(ctrl) {
          const enc = new TextEncoder();
          ctrl.enqueue(enc.encode(`${JSON.stringify({ type: 'PRICE', instrument: 'EUR_USD', time: new Date(NOW - 400).toISOString(), bids: [{ price: String(last.b.c) }], asks: [{ price: String(last.a.c) }], tradeable: true })}\n`));
          ctrl.enqueue(enc.encode(`${JSON.stringify({ type: 'HEARTBEAT', time: new Date(NOW - 100).toISOString() })}\n`));
          opts.signal?.addEventListener('abort', () => { try { ctrl.close(); } catch { /* */ } });
        },
      });
      return new Response(body, { status: 200 });
    }
    if (u.includes('/candles')) {
      const inst = u.match(/instruments\/(\w+)\/candles/)[1];
      if (inst !== 'EUR_USD') return new Response(JSON.stringify({ candles: [] }), { status: 200 });
      const s = v => String(v);
      return new Response(JSON.stringify({ candles: candles.map(c => ({ time: new Date(c.t).toISOString(), complete: true, volume: c.v, bid: { o: s(c.b.o), h: s(c.b.h), l: s(c.b.l), c: s(c.b.c) }, ask: { o: s(c.a.o), h: s(c.a.h), l: s(c.a.l), c: s(c.a.c) } })) }), { status: 200 });
    }
    if (u.includes('ff_calendar')) return new Response(JSON.stringify([{ title: 'Retail Sales m/m', country: 'USD', date: '2026-01-15T08:30:00-05:00', impact: 'High', forecast: '', previous: '' }]), { status: 200 });
    if (u.includes('api.telegram.org')) { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 }); }
    return new Response('{}', { status: 404 });
  };
  const db = openDb(':memory:');
  const secrets = secretStore(db, randomBytes(32));
  secrets.set('oanda.token', 'mock-oanda-token-123456');
  secrets.set('telegram.token', TG);
  assert.ok(saveConfig(db, { provider: { name: 'oanda', env: 'practice', accountId: '101-001-1-001' }, watchlist: ['EUR_USD'], strategies: { enabled: ['LEGACY_EMA_RSI_VOL'] }, notifications: { telegramEnabled: true, chatId: '12345', cooldownMin: 0 } }).ok);
  const log = { info() {}, warn() {}, error() {} };
  const engine = createEngine({ db, secrets, clock, fetchImpl, autoStart: false, log });
  await engine.start();
  const { server } = createApp({ db, engine, secrets, env: { FNX_ACCESS_PASSWORD: 'pw' }, log, fetchImpl });
  await new Promise(r => server.listen(0, r));
  try {
    for (let k = 0; k < 40 && !sent.length; k += 1) await new Promise(r => setTimeout(r, 250));
    const sig = db.get('SELECT * FROM signals');
    assert.ok(sig, 'signaal aangemaakt');
    assert.equal(sig.direction, 'LONG');
    assert.equal(sig.candle_t, last.t);
    assert.equal(sig.data_kind, 'real');
    assert.equal(sent.length, 1, 'precies één entrymelding');
    assert.match(sent[0].text, /BUY — mogelijke LONGentry/);
    assert.match(sent[0].text, new RegExp(sig.id));
    assert.equal(db.get("SELECT status FROM outbox WHERE kind='ENTRY'").status, 'SENT');
    // tweede scan van dezelfde candle: geen dubbel signaal of dubbele melding
    await engine.scanAll(last.t + 300_000);
    await new Promise(r => setTimeout(r, 3500));
    assert.equal(db.get('SELECT COUNT(*) n FROM signals').n, 1);
    assert.equal(sent.length, 1);
    // dashboard
    const lr = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'pw' }), headers: { 'content-type': 'application/json' } });
    const cookie = lr.headers.get('set-cookie').split(';')[0];
    const ov = await (await fetch(`http://127.0.0.1:${server.address().port}/api/overview`, { headers: { cookie } })).json();
    assert.equal(ov[0].activeSignals.length, 1);
    const st = await (await fetch(`http://127.0.0.1:${server.address().port}/api/status`, { headers: { cookie } })).json();
    assert.equal(st.mode, 'LIVE_ANALYSIS');
    assert.equal(st.provider.feedMode, 'stream');
    assert.ok(st.scan.lastOk);
    const txt = JSON.stringify(st) + JSON.stringify(ov);
    assert.ok(!txt.includes('mock-oanda-token') && !txt.includes('AAMockToken'));
  } finally { server.close(); await engine.stop(); }
});
