import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openDb, acquireLease, upsertCandles, heartbeat, setState } from '../src/store/db.js';
import { enqueue, processOutbox, recoverOutbox } from '../src/notify/telegram.js';
import { secretStore, signWorkerRequest, verifyWorkerRequest, hashPassword, verifyPassword, redact } from '../src/server/security.js';
import { createApp } from '../src/server/http.js';
import { createEngine } from '../src/engine/engine.js';
import { engineStatus, countMissedScans } from '../src/engine/status.js';
import { parseFF } from '../src/calendar/calendar.js';
import { parseCandle, parsePrice } from '../src/data/providers/oanda.js';
import { QuoteHub } from '../src/engine/quotes.js';
import net from 'node:net';
const require_net = () => net;

const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijk';
const jsonRes = (status, body) => ({ status, ok: status < 300, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() });

test('outbox: één signaal → hooguit één entrymelding (dedupe)', () => {
  const db = openDb(':memory:');
  assert.equal(enqueue(db, { signalId: 's1', kind: 'ENTRY', dedupeKey: 'ENTRY:k1', payload: { text: 'x' } }).ok, true);
  assert.equal(enqueue(db, { signalId: 's1', kind: 'ENTRY', dedupeKey: 'ENTRY:k1', payload: { text: 'x' } }).duplicate, true);
  assert.equal(db.get('SELECT COUNT(*) n FROM outbox').n, 1);
});

test('outbox: 429 respecteert Retry-After; daarna SENT', async () => {
  const db = openDb(':memory:'); let now = 1_000_000;
  enqueue(db, { signalId: null, kind: 'TEST', dedupeKey: 'T1', payload: { text: 'x' }, at: now });
  let calls = 0;
  const f = async () => { calls += 1; return calls === 1 ? jsonRes(429, { ok: false, parameters: { retry_after: 7 } }) : jsonRes(200, { ok: true, result: { message_id: 42 } }); };
  let r = await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: f, now: () => now });
  assert.equal(r[0].status, 'RETRY_SCHEDULED');
  r = await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: f, now: () => now + 5000 });
  assert.equal(r.length, 0, 'niet vóór Retry-After');
  r = await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: f, now: () => now + 7001 });
  assert.equal(r[0].status, 'SENT');
  assert.equal(db.get('SELECT provider_message_id m FROM outbox').m, '42');
});

test('outbox: timeout na verzending → UNKNOWN, niet blind opnieuw verstuurd', async () => {
  const db = openDb(':memory:');
  enqueue(db, { kind: 'TEST', dedupeKey: 'T2', payload: { text: 'x' } });
  let calls = 0;
  const f = (url, opts) => { calls += 1; return new Promise((_, rej) => opts.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); })); };
  const r = await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: f, timeoutMs: 50 });
  assert.equal(r[0].status, 'UNKNOWN');
  await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: f, timeoutMs: 50, now: () => Date.now() + 3600_000 });
  assert.equal(calls, 1);
});

test('outbox: herstart tussen claim en verzending → UNKNOWN', () => {
  const db = openDb(':memory:');
  enqueue(db, { kind: 'TEST', dedupeKey: 'T3', payload: { text: 'x' } });
  db.run("UPDATE outbox SET status='SENDING'");
  assert.equal(recoverOutbox(db), 1);
  assert.equal(db.get('SELECT status FROM outbox').status, 'UNKNOWN');
});

test('outbox: verouderde entry wordt vlak vóór verzending EXPIRED; token nooit in foutmelding', async () => {
  const db = openDb(':memory:');
  enqueue(db, { signalId: 's9', kind: 'ENTRY', dedupeKey: 'ENTRY:s9', payload: { text: 'x' } });
  let called = false;
  const r = await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: async () => { called = true; }, revalidate: () => ({ code: 'TTL_EXPIRED', text: 'verlopen' }) });
  assert.equal(r[0].status, 'EXPIRED'); assert.equal(called, false);
  enqueue(db, { kind: 'TEST', dedupeKey: 'T4', payload: { text: 'x' } });
  await processOutbox(db, { token: TOKEN, chatId: '1', fetchImpl: async () => { throw new Error(`connect failed https://api.telegram.org/bot${TOKEN}/sendMessage`); } });
  const err = db.get("SELECT last_error FROM outbox WHERE dedupe_key='T4'").last_error;
  assert.ok(!err.includes(TOKEN), err);
});

test('lease: parallelle workers — slechts één houdt de lease; overname na verlopen', () => {
  const db = openDb(':memory:');
  assert.equal(acquireLease(db, 'engine', 'A', 1000, 0), true);
  assert.equal(acquireLease(db, 'engine', 'B', 1000, 500), false);
  assert.equal(acquireLease(db, 'engine', 'A', 1000, 900), true);
  assert.equal(acquireLease(db, 'engine', 'B', 1000, 2500), true);
  assert.equal(acquireLease(db, 'engine', 'A', 1000, 2600), false);
});

test('herhaalde candle is idempotent; historische correctie krijgt revisie + melding', () => {
  const db = openDb(':memory:');
  const c = { t: 0, o: 1, h: 1.1, l: 0.9, c: 1.05, v: 5, complete: true };
  assert.equal(upsertCandles(db, 'd', 'EUR_USD', 'M5', [c]).inserted, 1);
  assert.equal(upsertCandles(db, 'd', 'EUR_USD', 'M5', [c]).unchanged, 1);
  assert.equal(upsertCandles(db, 'd', 'EUR_USD', 'M5', [{ ...c, c: 1.06 }]).revised, 1);
  assert.equal(db.get('SELECT revision FROM candles').revision, 1);
  assert.equal(db.get("SELECT COUNT(*) n FROM data_quality WHERE type='REVISION'").n, 1);
});

test('secrets: versleuteld opgeslagen, leeg veld wist niet, wachtwoordhash', () => {
  const db = openDb(':memory:'); const s = secretStore(db, randomBytes(32));
  s.set('oanda.token', 'abcdef1234567890');
  assert.ok(!JSON.stringify(db.all('SELECT * FROM secrets')).includes('abcdef1234567890'));
  assert.equal(s.set('oanda.token', ''), false);
  assert.equal(s.get('oanda.token'), 'abcdef1234567890');
  assert.equal(s.status()['oanda.token'].hint, '••••7890');
  const h = hashPassword('geheim'); assert.ok(verifyPassword('geheim', h)); assert.ok(!verifyPassword('fout', h));
  assert.ok(!redact(`Bearer ${'x'.repeat(30)}`).includes('xxxxxxxxxx'));
});

test('worker-authenticatie: geldig, verlopen, vervalst en replay', () => {
  const db = openDb(':memory:'); const secret = 'workersecret-123';
  const now = Date.now();
  const h = signWorkerRequest(secret, { method: 'POST', path: '/api/worker/tick', body: '{}', ts: now });
  assert.equal(verifyWorkerRequest(db, secret, { method: 'POST', path: '/api/worker/tick', body: '{}', headers: h }, now).ok, true);
  assert.equal(verifyWorkerRequest(db, secret, { method: 'POST', path: '/api/worker/tick', body: '{}', headers: h }, now).code, 'REPLAY');
  const old = signWorkerRequest(secret, { method: 'POST', path: '/api/worker/tick', body: '{}', ts: now - 120_000 });
  assert.equal(verifyWorkerRequest(db, secret, { method: 'POST', path: '/api/worker/tick', body: '{}', headers: old }, now).code, 'EXPIRED');
  const forged = signWorkerRequest('ander-secret', { method: 'POST', path: '/api/worker/tick', body: '{}', ts: now });
  assert.equal(verifyWorkerRequest(db, secret, { method: 'POST', path: '/api/worker/tick', body: '{}', headers: forged }, now).code, 'BAD_SIGNATURE');
  const tampered = signWorkerRequest(secret, { method: 'POST', path: '/api/worker/tick', body: '{}', ts: now });
  assert.equal(verifyWorkerRequest(db, secret, { method: 'POST', path: '/api/worker/tick', body: '{"x":1}', headers: tampered }, now).code, 'BAD_SIGNATURE');
});

test('gemiste heartbeat verandert de zichtbare status', () => {
  const db = openDb(':memory:');
  const now = Date.UTC(2026, 0, 13, 10, 0);
  heartbeat(db, 'engine', 'ok', { leader: true }, now - 5000);
  heartbeat(db, 'scan', 'ok', {}, now - 10 * 60_000);
  setState(db, 'provider', { id: 'demo' });
  const a = engineStatus(db, null, now);
  assert.ok(a.scan.missed >= 1);
  assert.ok(a.conditions.some(c => c.code === 'SCANS_MISSED'));
  const b = engineStatus(db, null, now + 5 * 60_000);
  assert.equal(b.headline.code, 'BACKGROUND_MISSED');
  assert.equal(countMissedScans(Date.UTC(2026, 0, 10, 12), Date.UTC(2026, 0, 10, 18), ['EUR_USD']), 0, 'weekend: geen gemiste scans');
});

test('OANDA-parsing: tickvolume en bid/ask; heartbeat', () => {
  const c = parseCandle({ time: '2026-01-13T10:00:00.000000000Z', complete: true, volume: 42, bid: { o: '1.1', h: '1.2', l: '1.0', c: '1.15' }, ask: { o: '1.1002', h: '1.2002', l: '1.0002', c: '1.1502' } }, 'EUR_USD');
  assert.equal(c.vType, 'tick_count'); assert.equal(c.t, Date.UTC(2026, 0, 13, 10)); assert.ok(Math.abs(c.c - 1.1501) < 1e-12);
  assert.equal(parsePrice({ type: 'HEARTBEAT', time: '2026-01-13T10:00:05Z' }, 1).type, 'HEARTBEAT');
  const p = parsePrice({ type: 'PRICE', instrument: 'EUR_USD', time: '2026-01-13T10:00:05.5Z', bids: [{ price: '1.1' }], asks: [{ price: '1.1001' }] }, 2);
  assert.equal(p.bid, 1.1); assert.equal(p.ask, 1.1001);
});

test('QuoteHub: ongewijzigde prijs met heartbeat ≠ verbroken; zonder heartbeat STALE; nooit lokale timestamp', () => {
  const h = new QuoteHub(); h.connected = true; h.mode = 'stream';
  h.update({ instrument: 'EUR_USD', bid: 1, ask: 1.0001, time: 1000, receivedAt: 1000 });
  h.heartbeat(9000, 9000);
  assert.equal(h.freshness('EUR_USD', 9500).state, 'UNCHANGED');
  assert.equal(h.gatingQuote('EUR_USD', 9500).quoteTime, 1000);
  assert.equal(h.freshness('EUR_USD', 30_000).state, 'STALE');
  h.connected = false; assert.equal(h.freshness('EUR_USD', 9500).state, 'DISCONNECTED');
  h.connected = true; h.update({ instrument: 'EUR_USD', bid: 0.9, ask: 0.9001, time: 500, receivedAt: 9600 });
  assert.equal(h.get('EUR_USD').bid, 1, 'oudere update na reconnect genegeerd');
});

test('kalenderparsing: weekdekking zondag–zondag (ET)', () => {
  const { events, coverage } = parseFF([{ title: 'CPI m/m', country: 'USD', date: '2026-11-04T08:30:00-05:00', impact: 'High', forecast: '0.3%', previous: '0.2%' }], 0);
  assert.equal(events[0].category, 'CPI');
  assert.equal(coverage.from, Date.UTC(2026, 10, 1, 4)); // zondag 1 nov 00:00 EDT
  assert.equal(coverage.to, Date.UTC(2026, 10, 8, 5)); // zondag 8 nov 00:00 EST
});

// ---------- API-integratie ----------
async function startApp() {
  const db = openDb(':memory:'); const secrets = secretStore(db, randomBytes(32));
  secrets.set('telegram.token', TOKEN);
  const engine = createEngine({ db, secrets, autoStart: false, log: { info() {}, warn() {}, error() {} } });
  const { server } = createApp({ db, engine, secrets, env: { FNX_ACCESS_PASSWORD: 'pw-test-123', FNX_WORKER_SECRET: 'ws' }, log: { error() {} } });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, server, base, engine };
}

test('API: auth vereist, CSRF verplicht, geen secrets in responses, strikte validatie', async () => {
  const { server, base } = await startApp();
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'fout' }), headers: { 'content-type': 'application/json' } })).status, 401);
    const lr = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'pw-test-123' }), headers: { 'content-type': 'application/json' } });
    const cookie = lr.headers.get('set-cookie').split(';')[0]; const { csrf } = await lr.json();
    assert.match(lr.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const noCsrf = await fetch(`${base}/api/settings`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noCsrf.status, 403);
    const bad = await fetch(`${base}/api/settings`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ provider: { name: 'evil' } }) });
    assert.equal(bad.status, 400);
    const unknown = await fetch(`${base}/api/settings`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ hacker: 1 }) });
    assert.equal(unknown.status, 400);
    const big = await fetch(`${base}/api/settings`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
    for (const p of ['/api/meta', '/api/settings', '/api/status']) {
      const t = await (await fetch(`${base}${p}`, { headers: { cookie } })).text();
      assert.ok(!t.includes(TOKEN) && !t.includes('AAFakeToken'), `secret gelekt in ${p}`);
    }
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(!html.includes('AAFakeToken'));
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
    assert.match(csp, /script-src 'self' 'sha256-/); assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
    // vreemde paden laten de server niet crashen
    const raw = await new Promise(r => { const sock = require_net().connect(Number(new URL(base).port), '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')); let b = ''; sock.on('data', d => { b += d; }); sock.on('close', () => r(b)); sock.on('error', () => r(b)); });
    assert.match(raw, /^HTTP\/1\.1 (200|400|404)/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const w = await fetch(`${base}/api/worker/tick`, { method: 'POST', body: '{}', headers: signWorkerRequest('fout', { method: 'POST', path: '/api/worker/tick', body: '{}' }) });
    assert.equal(w.status, 401);
    const w2 = await fetch(`${base}/api/worker/tick`, { method: 'POST', body: '{}', headers: signWorkerRequest('ws', { method: 'POST', path: '/api/worker/tick', body: '{}' }) });
    assert.equal(w2.status, 200);
  } finally { server.close(); }
});

test('API: CSV-import met gaten → kwaliteitsrapport; dubbel bestand geweigerd', async () => {
  const { server, base } = await startApp();
  try {
    const lr = await fetch(`${base}/api/login`, { method: 'POST', body: JSON.stringify({ password: 'pw-test-123' }), headers: { 'content-type': 'application/json' } });
    const cookie = lr.headers.get('set-cookie').split(';')[0]; const { csrf } = await lr.json();
    const csv = 'time,open,high,low,close\n2026-01-13T09:00:00Z,1.1,1.101,1.099,1.1\n2026-01-13T09:05:00Z,1.1,1.101,1.099,1.1\n2026-01-13T09:40:00Z,1.1,1.101,1.099,1.1\n2026-01-13T09:40:00Z,1.1,1.101,1.099,1.1\n';
    const r = await (await fetch(`${base}/api/datasets/import?instrument=EUR_USD&timeframe=M5&filename=t.csv`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: csv })).json();
    assert.equal(r.ok, true); assert.equal(r.quality.gapCount, 1); assert.equal(r.quality.missingCandles, 6); assert.equal(r.quality.counts.DUPLICATE, 1);
    const r2 = await (await fetch(`${base}/api/datasets/import?instrument=EUR_USD&timeframe=M5&filename=t.csv`, { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: csv })).json();
    assert.equal(r2.duplicate, true);
    const mx = await (await fetch(`${base}/api/matrix`, { headers: { cookie } })).json();
    assert.ok(mx.some(x => x.instrument === 'MES' && x.status === 'GEBLOKKEERD'));
    assert.ok(mx.some(x => x.newsPolicy.startsWith('Blackout') && x.status === 'GEBLOKKEERD'));
  } finally { server.close(); }
});
