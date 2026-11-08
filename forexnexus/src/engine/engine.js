// Achtergrondengine. Draait server-side in een langlopend proces, los van de
// browser. Taken (afzonderlijk, niet-blokkerend):
//   - quote-ingestie (OANDA-stream met reconnect, of polling-fallback, of DEMO)
//   - M5-strategie-evaluatie op candlegrenzen (geen cumulatieve drift)
//   - signaallifecycle (verlopen, gemist, ingetrokken)
//   - paperposities bewaken
//   - kalender verversen
//   - Telegram-outbox verwerken
//   - heartbeats + lease tegen dubbele workers

import { randomUUID, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { QuoteHub } from './quotes.js';
import { loadConfig, configVersion } from './config.js';
import { createDemoProvider } from '../data/providers/demo.js';
import { createOandaProvider } from '../data/providers/oanda.js';
import { prepareSeries, evaluate, entryStillValid } from '../core/evaluate.js';
import { getStrategy, STRATEGIES, strategyCard } from '../core/strategies/index.js';
import { getInstrument, INSTRUMENTS, moneyPerUnit, fmtPrice } from '../core/instruments.js';
import { marketStatus } from '../core/sessions.js';
import { validateCandles } from '../core/quality.js';
import { TF_MS, floorTf, nextBoundary, iso } from '../core/time.js';
import { slippagePrice, positionSize } from '../core/risk.js';
import { newsCheck } from '../core/news.js';
import { reason } from '../core/reasons.js';
import { heartbeat, upsertCandles, loadCandles, setState, getState, acquireLease, releaseLease, lastHeartbeat } from '../store/db.js';
import { loadCalendar, refreshCalendar } from '../calendar/calendar.js';
import { enqueue, processOutbox, recoverOutbox, formatEntry } from '../notify/telegram.js';
import { redact } from '../server/security.js';

const LEASE = 'engine';

export function liveDatasetId(cfg) {
  return cfg.provider.name === 'oanda' ? `live:oanda:${cfg.provider.env}` : 'live:demo';
}

export function modeLabel(cfg) {
  return cfg.provider.name === 'demo' ? 'DEMO (synthetisch)' : `Live analyse (${cfg.provider.env === 'live' ? 'OANDA live-data' : 'OANDA practice-data'}) — geen automatische orders`;
}

export function createEngine({ db, secrets, log = console, clock = () => Date.now(), fetchImpl = fetch, autoStart = true }) {
  const owner = `${hostname()}:${process.pid}:${randomBytes(3).toString('hex')}`;
  const hub = new QuoteHub();
  const timers = new Set();
  const events = new Set(); // SSE-luisteraars
  let cfg = loadConfig(db);
  let provider = null; let streamAbort = null; let leader = false; let stopped = false;
  let scanRunning = false; let nextScanAt = null; let lastQuoteSnapshot = new Map();

  const emit = (type, data) => { for (const fn of events) { try { fn(type, data); } catch { /* */ } } };
  const every = (ms, fn) => { const h = setInterval(() => { if (!stopped) Promise.resolve().then(fn).catch(e => log.error?.('[engine]', redact(e.message))); }, ms); h.unref?.(); timers.add(h); return h; };
  const later = (ms, fn) => { const h = setTimeout(() => { timers.delete(h); if (!stopped) Promise.resolve().then(fn).catch(e => log.error?.('[engine]', redact(e.message))); }, Math.max(0, ms)); h.unref?.(); timers.add(h); return h; };

  function secretList() { return [secrets.get('oanda.token'), secrets.get('telegram.token')].filter(Boolean); }

  function buildProvider() {
    cfg = loadConfig(db);
    if (cfg.provider.name === 'oanda') {
      const token = secrets.get('oanda.token');
      if (!token || !cfg.provider.accountId) return { provider: null, problem: reason('PROVIDER_NOT_CONFIGURED', !token ? 'OANDA-token ontbreekt' : 'Account-ID ontbreekt') };
      return { provider: createOandaProvider({ token, accountId: cfg.provider.accountId, env: cfg.provider.env, fetchImpl }) };
    }
    return { provider: createDemoProvider() };
  }

  // ---------- quote-ingestie ----------
  async function runStream() {
    let attempt = 0; let failures = 0;
    while (!stopped && provider && provider.id === 'oanda') {
      streamAbort = new AbortController();
      const watchdog = setInterval(() => {
        if (hub.heartbeatReceivedAt && clock() - hub.heartbeatReceivedAt > 20_000) streamAbort.abort(new Error('heartbeat-timeout'));
      }, 5000);
      try {
        hub.mode = 'stream'; hub.lastError = null;
        heartbeat(db, 'stream', 'ok', { event: 'connecting', attempt });
        await provider.stream(cfg.watchlist.filter(w => INSTRUMENTS[w].providers.oanda), msg => {
          if (!hub.connected) { hub.connected = true; attempt = 0; failures = 0; heartbeat(db, 'stream', 'ok', { event: 'connected' }); emit('status', { feed: 'connected' }); }
          if (msg.type === 'HEARTBEAT') hub.heartbeat(msg.time, msg.receivedAt);
          else onQuote(msg);
        }, streamAbort.signal);
        throw new Error('stream beëindigd');
      } catch (e) {
        hub.connected = false; hub.lastError = redact(e.message, secretList());
        heartbeat(db, 'stream', 'error', { error: hub.lastError, attempt });
        emit('status', { feed: 'disconnected', error: hub.lastError });
        if (stopped) break;
        failures += 1; attempt += 1;
        if (e.code === 'UNAUTHORIZED') { log.warn?.('[stream] token geweigerd; stream gestopt'); break; }
        if (failures >= 3) { await runPolling(5 * 60_000); failures = 0; continue; }
        const wait = Math.min(60_000, 1000 * 2 ** attempt) * (0.5 + Math.random());
        await sleep(wait);
      } finally { clearInterval(watchdog); }
    }
  }

  /** Polling-fallback: wordt in de UI expliciet als 'live polling' met interval getoond. */
  async function runPolling(durationMs, intervalMs = 2000) {
    hub.mode = 'polling'; hub.pollIntervalMs = intervalMs;
    const until = clock() + durationMs;
    while (!stopped && clock() < until && provider) {
      try {
        const qs = await provider.getQuotes(cfg.watchlist);
        hub.connected = true;
        for (const q of qs) onQuote(q);
      } catch (e) { hub.connected = false; hub.lastError = redact(e.message, secretList()); }
      await sleep(intervalMs);
    }
    hub.pollIntervalMs = null;
  }

  function runDemoQuotes() {
    hub.mode = 'demo'; hub.connected = true;
    every(1000, () => {
      // geen synthetische koersbewegingen buiten de markturen
      for (const id of cfg.watchlist) { if (!marketStatus(getInstrument(id), clock(), { fxHolidays: cfg.fxHolidays }).open) continue; const q = provider.quote?.(id, clock()); if (q) onQuote(q); }
      hub.heartbeat(clock(), clock());
    });
  }

  function onQuote(q) {
    hub.update(q);
    emit('quote', q);
    // quote-snapshot hooguit 1× per minuut per instrument (retentie: 7 dagen)
    const last = lastQuoteSnapshot.get(q.instrument) || 0;
    if (q.time - last >= 60_000) {
      lastQuoteSnapshot.set(q.instrument, q.time);
      try { db.run('INSERT OR IGNORE INTO quote_snapshots (instrument, provider, time, received_at, bid, ask) VALUES (?,?,?,?,?,?)', q.instrument, q.source, q.time, q.receivedAt ?? q.time, q.bid, q.ask); } catch { /* */ }
      heartbeat(db, 'quote', 'ok', { instrument: q.instrument, time: q.time, source: q.source });
    }
    monitorPaper(q);
    monitorSignals(q);
  }

  // ---------- M5-scheduler ----------
  function scheduleNextScan() {
    const now = clock();
    const delay = (cfg.scheduler?.evalDelaySec ?? 5) * 1000;
    let target = nextBoundary(now, 'M5') + delay;
    if (target - TF_MS.M5 > now) target -= TF_MS.M5; // nog binnen de vertraging van de huidige grens
    nextScanAt = target;
    setState(db, 'scheduler', { nextScanAt: target, owner, computedAt: now });
    later(target - now, async () => { await scanAll(floorTf(target, 'M5')); scheduleNextScan(); });
  }

  async function scanAll(boundary) {
    if (!leader || scanRunning) { heartbeat(db, 'scan', 'skipped', { reason: !leader ? 'geen lease' : 'vorige scan loopt nog', boundary }); return; }
    scanRunning = true;
    const startedAt = clock();
    try {
      cfg = loadConfig(db);
      if (!provider) { heartbeat(db, 'scan', 'error', { boundary, error: 'Geen provider gekoppeld' }); return; }
      const results = await Promise.allSettled(cfg.watchlist.map(id => withTimeout(scanInstrument(id, boundary), 25_000, `scan ${id}`)));
      const detail = results.map((r, k) => r.status === 'fulfilled' ? r.value : { instrument: cfg.watchlist[k], error: redact(r.reason?.message, secretList()) });
      const anyError = detail.some(d => d.error);
      heartbeat(db, 'scan', anyError ? 'error' : 'ok', { boundary, durationMs: clock() - startedAt, results: detail, provider: provider.id });
      setState(db, 'lastScan', { at: clock(), boundary, results: detail });
      emit('scan', { boundary, results: detail });
    } finally { scanRunning = false; }
  }

  async function scanInstrument(id, boundary) {
    const inst = getInstrument(id);
    const tf = 'M5';
    const mkt = marketStatus(inst, clock(), { fxHolidays: cfg.fxHolidays });
    const ds = liveDatasetId(cfg);
    const expectedLast = boundary - TF_MS[tf];
    let fetched = null; let tries = 0;
    for (;;) {
      tries += 1;
      fetched = await provider.fetchCandles(provider.id === 'oanda' ? inst.providers.oanda : id, tf, { count: 400, to: boundary });
      const lastComplete = [...fetched].reverse().find(c => c.complete);
      if (!mkt.open || (lastComplete && lastComplete.t >= expectedLast) || tries > (cfg.scheduler?.candleRetries ?? 3)) break;
      await sleep((cfg.scheduler?.candleRetrySec ?? 10) * 1000);
    }
    const v = validateCandles(fetched.filter(c => c.complete), { inst, tf, maxSpreadPrice: inst.pip ? inst.pip * 20 : null });
    const up = upsertCandles(db, ds, id, tf, v.clean, clock());
    if (v.issues.length) db.run('INSERT INTO data_quality (at, dataset_id, instrument, type, detail) VALUES (?,?,?,?,?)', clock(), ds, id, 'SCAN_VALIDATION', JSON.stringify(v.report));
    const candles = loadCandles(db, ds, id, tf, { limit: 600 });
    const last = candles.at(-1);
    const out = { instrument: id, market: mkt.reason, lastCandle: last ? iso(last.t) : null, stored: up, evaluations: [] };
    if (!last) { out.state = 'NO_DATA'; return out; }
    if (last.t < expectedLast && mkt.open) out.candleMissing = reason('CANDLE_NOT_AVAILABLE', `laatste ${iso(last.t)}, verwacht ${iso(expectedLast)}`);
    const i = candles.length - 1;
    const calendar = loadCalendar(db, clock());
    const kind = provider.kind === 'synthetic' ? 'synthetic' : 'real';
    for (const sid of cfg.strategies.enabled) {
      const strat = getStrategy(sid);
      if (!strat.instruments.includes(id)) continue;
      const series = prepareSeries(candles, inst, tf, strat, { provider: provider.id, kind, sessions: cfg.sessions });
      const lastSig = db.get('SELECT candle_t, created_at FROM signals WHERE instrument = ? AND strategy = ? AND version = ? ORDER BY candle_t DESC LIMIT 1', id, strat.id, strat.version);
      const keys = new Set(db.all('SELECT key FROM signals WHERE instrument = ? AND candle_t >= ?', id, last.t - 86_400_000).map(r => r.key));
      const d = evaluate(series, i, strat, {
        mode: provider.kind === 'synthetic' ? 'demo' : 'live', now: clock(),
        quote: hub.gatingQuote(id, clock(), cfg.limits.maxQuoteAgeSec),
        calendar, newsPolicy: cfg.newsPolicy, sessions: cfg.sessions, limits: cfg.limits, costs: cfg.costs,
        accountCcy: cfg.risk.accountCcy, rates: currentRates(), marketCfg: { fxHolidays: cfg.fxHolidays },
        state: { lastSignalTime: lastSig ? lastSig.candle_t + TF_MS[tf] : null, existingKeys: keys },
      });
      if (out.candleMissing && last.t < expectedLast) d.blockers.push(out.candleMissing);
      d.instrumentDisplay = inst.display;
      storeEvaluation(d);
      if (d.state === 'BUY' || d.state === 'SELL') createSignal(d, inst);
      out.evaluations.push({ strategy: sid, state: d.state, blockers: d.blockers.map(b => b.code) });
    }
    return out;
  }

  function storeEvaluation(d) {
    const cv = configVersion(db, cfg);
    db.run('INSERT OR REPLACE INTO evaluations (instrument, strategy, version, candle_t, evaluated_at, mode, state, direction, blockers, decision, config_version) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      d.instrument, d.strategy.id, d.strategy.version, d.candleTime, d.evaluatedAt, d.mode, d.state, d.direction, JSON.stringify(d.blockers), JSON.stringify(d), cv);
    emit('evaluation', { instrument: d.instrument, strategy: d.strategy.id, state: d.state });
  }

  function createSignal(d, inst) {
    const id = `sig_${randomUUID().slice(0, 18)}`;
    const now = clock();
    const cv = configVersion(db, cfg);
    let created = false;
    db.tx(() => {
      try {
        db.run('INSERT INTO signals (id, key, instrument, contract, strategy, version, timeframe, candle_t, direction, mode, data_kind, provider, status, entry_ref, sl, tp1, tp2, expires_at, created_at, snapshot, config_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          id, d.key, d.instrument, null, d.strategy.id, d.strategy.version, d.timeframe, d.candleTime, d.direction, d.mode, d.dataKind, d.provider, 'ACTIVE', d.entryRef, d.plan.sl, d.plan.tp1, d.plan.tp2, d.expiresAt, now, JSON.stringify(d), cv);
      } catch (e) { if (/UNIQUE/i.test(e.message)) return; throw e; }
      created = true;
      db.run('INSERT INTO signal_events (signal_id, at, type, detail) VALUES (?,?,?,?)', id, now, 'CREATED', JSON.stringify({ state: d.state, entryRef: d.entryRef }));
      const n = cfg.notifications;
      if (d.alertable && n.telegramEnabled && n.entry && cooldownOk(d)) {
        const sig = { id, instrument: d.instrument, timeframe: d.timeframe, direction: d.direction, expires_at: d.expiresAt, contract: null, snapshot: d, modeLabel: modeLabel(cfg) };
        d.instrumentDisplay = inst.display;
        enqueue(db, { signalId: id, kind: 'ENTRY', dedupeKey: `ENTRY:${d.key}`, payload: { text: formatEntry(sig, { appUrl: cfg.appUrl, fmt: p => fmtPrice(inst, p) }) }, at: now });
      }
    });
    if (!created) return null;
    emit('signal', { id, instrument: d.instrument, state: d.state });
    if (cfg.paper.autoStrategy === d.strategy.id && d.alertable) openPaper(id, 'AUTO');
    return id;
  }

  function cooldownOk(d) {
    const min = cfg.notifications.cooldownMin || 0;
    if (!min) return true;
    const r = db.get("SELECT o.created_at FROM outbox o JOIN signals s ON s.id = o.signal_id WHERE o.kind = 'ENTRY' AND s.instrument = ? AND o.created_at > ? LIMIT 1", d.instrument, clock() - min * 60_000);
    return !r;
  }

  // ---------- signaallifecycle ----------
  function signalEvent(id, type, detail, status) {
    db.tx(() => {
      db.run('INSERT INTO signal_events (signal_id, at, type, detail) VALUES (?,?,?,?)', id, clock(), type, JSON.stringify(detail || {}));
      if (status) db.run('UPDATE signals SET status = ? WHERE id = ?', status, id);
    });
    emit('signal', { id, type });
  }

  function monitorSignals(q) {
    const active = db.all("SELECT * FROM signals WHERE status = 'ACTIVE' AND instrument = ?", q.instrument);
    for (const s of active) {
      const snap = JSON.parse(s.snapshot);
      const sig = { ...snap, expiresAt: s.expires_at, entryRef: s.entry_ref, direction: s.direction };
      const r = entryStillValid(sig, hub.gatingQuote(s.instrument, clock(), cfg.limits.maxQuoteAgeSec), clock(), { ...cfg.limits });
      if (!r) continue;
      if (r.code === 'ENTRY_MISSED') { signalEvent(s.id, 'ENTRY_MISSED', r, 'ENTRY_MISSED'); maybeStatusMessage(s, 'CANCELLED', `ENTRY GEMIST — ${r.detail || r.text}`); }
    }
  }

  function lifecycleSweep() {
    const now = clock();
    for (const s of db.all("SELECT * FROM signals WHERE status = 'ACTIVE' AND expires_at < ?", now)) {
      signalEvent(s.id, 'EXPIRED', { at: now }, 'EXPIRED');
      maybeStatusMessage(s, 'EXPIRED', 'EXPIRED — entryvenster verlopen');
    }
    // intrekken bij een nieuwsblackout die begint vóór het einde van het entryvenster
    const cal = loadCalendar(db, now);
    for (const s of db.all("SELECT * FROM signals WHERE status = 'ACTIVE'")) {
      const nc = newsCheck(getInstrument(s.instrument), now, cal, cfg.newsPolicy);
      if (nc.active) { signalEvent(s.id, 'CANCELLED', { reason: 'NEWS_BLACKOUT', event: nc.active.event.title }, 'CANCELLED'); maybeStatusMessage(s, 'CANCELLED', `CANCELLED — nieuwsblackout ${nc.active.event.currency} ${nc.active.event.title}`); }
    }
  }

  function maybeStatusMessage(s, kind, text) {
    const n = cfg.notifications;
    if (!n.telegramEnabled || s.data_kind !== 'real') return;
    if (kind === 'CANCELLED' && !n.cancelled) return;
    if (kind === 'EXPIRED' && !n.expired) return;
    // alleen een statusmelding als er een entrymelding is verstuurd
    const entry = db.get("SELECT status FROM outbox WHERE signal_id = ? AND kind = 'ENTRY'", s.id);
    if (!entry || !['SENT', 'UNKNOWN'].includes(entry.status)) {
      if (entry && ['PENDING', 'RETRY_SCHEDULED'].includes(entry.status)) db.run("UPDATE outbox SET status = 'CANCELLED', updated_at = ? WHERE signal_id = ? AND kind = 'ENTRY'", clock(), s.id);
      return;
    }
    enqueue(db, { signalId: s.id, kind, dedupeKey: `${kind}:${s.key}`, payload: { text: `<b>${text}</b>\n${s.instrument} · ${s.strategy} · Signaal-ID <code>${s.id}</code>` } });
  }

  // ---------- paper trading ----------
  function openPaper(signalId, origin = 'MANUAL', units = null) {
    const s = db.get('SELECT * FROM signals WHERE id = ?', signalId);
    if (!s) return { ok: false, code: 'NOT_FOUND' };
    const inst = getInstrument(s.instrument);
    const snap = JSON.parse(s.snapshot);
    const orderId = `po_${randomUUID().slice(0, 12)}`;
    const now = clock();
    const q = hub.gatingQuote(s.instrument, now, cfg.limits.maxQuoteAgeSec);
    const reject = (code, text) => {
      db.run('INSERT INTO paper_orders (id, signal_id, origin, instrument, direction, requested_at, status, reason, quote) VALUES (?,?,?,?,?,?,?,?,?)', orderId, signalId, origin, s.instrument, s.direction, now, 'REJECTED', `${code}: ${text}`, JSON.stringify(q));
      db.run('INSERT INTO paper_events (order_id, at, type, detail) VALUES (?,?,?,?)', orderId, now, 'ENTRY_REJECTED', JSON.stringify({ code, text }));
      return { ok: false, code, text, orderId };
    };
    if (s.status !== 'ACTIVE') return reject('SIGNAL_NOT_ACTIVE', `Signaalstatus ${s.status}`);
    const open = db.get("SELECT COUNT(*) n FROM paper_positions WHERE status = 'OPEN'").n;
    if (cfg.risk.maxPositions && open >= cfg.risk.maxPositions) return reject('MAX_POSITIONS', `Maximaal ${cfg.risk.maxPositions} gelijktijdige posities`);
    const inv = entryStillValid({ ...snap, expiresAt: s.expires_at, entryRef: s.entry_ref, direction: s.direction }, q, now, cfg.limits);
    if (inv) return reject(inv.code, inv.text);
    let size = units;
    if (size == null) {
      const ps = positionSize({ inst, plan: snap.plan, balance: cfg.risk.balance, riskPct: cfg.risk.riskPct, riskMoney: cfg.risk.riskMoney, accountCcy: cfg.risk.accountCcy, rates: currentRates(), costs: cfg.costs, costBufferPct: cfg.risk.costBufferPct });
      if (!ps.ok) return reject(ps.reason, ps.text);
      if (!ps.size) return reject('SIZE_ZERO', ps.warnings.join(' '));
      size = ps.size;
    }
    const slip = slippagePrice(inst, cfg.costs);
    const long = s.direction === 'LONG';
    const fill = long ? q.ask + slip : q.bid - slip;
    const posId = `pp_${randomUUID().slice(0, 12)}`;
    const tp = snap.plan[snap.plan.exitTarget];
    db.tx(() => {
      db.run('INSERT INTO paper_orders (id, signal_id, origin, instrument, direction, requested_at, status, units, fill_price, fill_time, quote) VALUES (?,?,?,?,?,?,?,?,?,?,?)', orderId, signalId, origin, s.instrument, s.direction, now, 'ACCEPTED', size, fill, now, JSON.stringify(q));
      db.run('INSERT INTO paper_positions (id, order_id, signal_id, origin, instrument, direction, units, entry, sl, tp, status, opened_at, costs) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', posId, orderId, signalId, origin, s.instrument, s.direction, size, fill, snap.plan.sl, tp, 'OPEN', now, JSON.stringify({ slippagePerSide: cfg.costs.slippagePerSide, spread: q.ask - q.bid, quoteTime: q.quoteTime }));
      db.run('INSERT INTO paper_events (position_id, order_id, at, type, detail) VALUES (?,?,?,?,?)', posId, orderId, now, 'FILL', JSON.stringify({ price: fill, bid: q.bid, ask: q.ask, slippage: slip }));
      db.run("UPDATE signals SET status = 'TAKEN' WHERE id = ?", signalId);
      db.run('INSERT INTO signal_events (signal_id, at, type, detail) VALUES (?,?,?,?)', signalId, now, 'PAPER_ENTRY', JSON.stringify({ positionId: posId, origin, fill }));
    });
    emit('paper', { positionId: posId });
    return { ok: true, positionId: posId, orderId, fill, units: size };
  }

  function closePaper(posId, exitPx, why) {
    const p = db.get("SELECT * FROM paper_positions WHERE id = ? AND status = 'OPEN'", posId);
    if (!p) return { ok: false, code: 'NOT_OPEN' };
    const inst = getInstrument(p.instrument);
    const long = p.direction === 'LONG';
    const risk = Math.abs(p.entry - p.sl);
    const pnlPrice = long ? exitPx - p.entry : p.entry - exitPx;
    const r = risk > 0 ? pnlPrice / risk : null;
    const money = moneyPerUnit(inst, pnlPrice, cfg.risk.accountCcy, currentRates());
    const now = clock();
    db.tx(() => {
      db.run("UPDATE paper_positions SET status='CLOSED', closed_at=?, exit_price=?, exit_reason=?, realized_r=?, realized_money=? WHERE id=?", now, exitPx, why, r, money == null ? null : money * p.units, posId);
      db.run('INSERT INTO paper_events (position_id, at, type, detail) VALUES (?,?,?,?)', posId, now, 'EXIT', JSON.stringify({ price: exitPx, reason: why, r }));
      if (p.signal_id) db.run('INSERT INTO signal_events (signal_id, at, type, detail) VALUES (?,?,?,?)', p.signal_id, now, long ? 'EXIT_LONG' : 'EXIT_SHORT', JSON.stringify({ positionId: posId, price: exitPx, reason: why, r }));
    });
    const sig = p.signal_id ? db.get('SELECT * FROM signals WHERE id = ?', p.signal_id) : null;
    if (sig && cfg.notifications.telegramEnabled && cfg.notifications.paperExit && sig.data_kind === 'real') {
      enqueue(db, { signalId: sig.id, kind: 'EXIT', dedupeKey: `EXIT:${posId}`, payload: { text: `<b>${long ? 'EXIT LONG' : 'EXIT SHORT'} (paper)</b>\n${inst.display} @ ${fmtPrice(inst, exitPx)} · ${why} · ${r == null ? '' : r.toFixed(2) + ' R'}\nPositie ${posId}` } });
    }
    emit('paper', { positionId: posId, closed: true });
    return { ok: true, r, exitPx };
  }

  function monitorPaper(q) {
    const slipOf = inst => slippagePrice(inst, cfg.costs);
    for (const p of db.all("SELECT * FROM paper_positions WHERE status = 'OPEN' AND instrument = ?", q.instrument)) {
      const inst = getInstrument(p.instrument); const slip = slipOf(inst);
      if (p.direction === 'LONG') {
        if (q.bid <= p.sl) closePaper(p.id, q.bid - slip, q.bid < p.sl ? 'SL (koers voorbij stop)' : 'SL');
        else if (p.tp != null && q.bid >= p.tp) closePaper(p.id, p.tp, 'TP');
      } else {
        if (q.ask >= p.sl) closePaper(p.id, q.ask + slip, q.ask > p.sl ? 'SL (koers voorbij stop)' : 'SL');
        else if (p.tp != null && q.ask <= p.tp) closePaper(p.id, p.tp, 'TP');
      }
    }
  }

  function currentRates() {
    const r = {};
    for (const [id, q] of hub.quotes) r[id] = (q.bid + q.ask) / 2;
    return r;
  }

  // ---------- telegram ----------
  async function outboxTick() {
    const token = secrets.get('telegram.token');
    await processOutbox(db, {
      token, chatId: cfg.notifications.chatId, fetchImpl, now: clock,
      revalidate: item => {
        const s = db.get('SELECT * FROM signals WHERE id = ?', item.signal_id);
        if (!s) return reason('TTL_EXPIRED', 'signaal onbekend');
        if (s.status !== 'ACTIVE') return reason('TTL_EXPIRED', `signaalstatus ${s.status}`);
        const snap = JSON.parse(s.snapshot);
        return entryStillValid({ ...snap, expiresAt: s.expires_at, entryRef: s.entry_ref, direction: s.direction }, hub.gatingQuote(s.instrument, clock(), cfg.limits.maxQuoteAgeSec), clock(), cfg.limits);
      },
    });
  }

  // ---------- lease + heartbeat ----------
  function leaseTick() {
    const was = leader;
    leader = acquireLease(db, LEASE, owner, 45_000, clock());
    heartbeat(db, 'engine', 'ok', { owner, leader, provider: provider?.id || null, feed: hub.mode, connected: hub.connected });
    if (leader && !was) log.info?.(`[engine] lease verkregen door ${owner}`);
    if (!leader && was) log.warn?.('[engine] lease verloren');
  }

  function retention() {
    const now = clock();
    db.run('DELETE FROM heartbeats WHERE at < ?', now - 14 * 86_400_000);
    db.run('DELETE FROM quote_snapshots WHERE time < ?', now - 7 * 86_400_000);
    db.run("DELETE FROM evaluations WHERE evaluated_at < ? AND state IN ('NONE')", now - 30 * 86_400_000);
    db.run('DELETE FROM sessions WHERE expires_at < ?', now);
  }

  async function start() {
    stopped = false;
    const rec = recoverOutbox(db, clock());
    if (rec) log.warn?.(`[engine] ${rec} outbox-item(s) op UNKNOWN gezet na herstart`);
    for (const s of Object.values(STRATEGIES)) db.run('INSERT OR IGNORE INTO strategy_versions (id, version, family, definition, created_at) VALUES (?,?,?,?,?)', s.id, s.version, s.family, JSON.stringify(strategyCard(s)), clock());
    for (const i of Object.values(INSTRUMENTS)) db.run('INSERT OR REPLACE INTO instruments (id, json, updated_at) VALUES (?,?,?)', i.id, JSON.stringify(i), clock());
    const b = buildProvider(); provider = b.provider;
    setState(db, 'provider', { id: provider?.id || null, problem: b.problem || null, kind: provider?.kind || null, label: provider?.label || null, since: clock() });
    leaseTick();
    every(15_000, leaseTick);
    if (provider?.id === 'oanda') runStream();
    else if (provider?.id === 'demo') runDemoQuotes();
    every(3000, outboxTick);
    every(5000, lifecycleSweep);
    every(3_600_000, retention);
    const cal = lastHeartbeat(db, 'calendar', 'ok');
    if (!cal || clock() - cal.at > 30 * 60_000) refreshCalendar(db, { fetchImpl, now: clock() }).catch(() => {});
    every(30 * 60_000, () => refreshCalendar(db, { fetchImpl, now: clock() }));
    scheduleNextScan();
    // directe eerste evaluatie (historie laden), los van de grens
    later(1500, () => scanAll(floorTf(clock(), 'M5')));
  }

  async function restart() {
    await stop(false);
    for (const h of timers) { clearInterval(h); clearTimeout(h); }
    timers.clear();
    hub.connected = false; hub.quotes.clear();
    await start();
  }

  async function stop(release = true) {
    stopped = true;
    streamAbort?.abort(new Error('stop'));
    for (const h of timers) { clearInterval(h); clearTimeout(h); }
    timers.clear();
    if (release) releaseLease(db, LEASE, owner);
  }

  if (autoStart) start();

  return {
    hub, owner, start, stop, restart, scanAll, openPaper, closePaper, currentRates,
    get leader() { return leader; },
    get provider() { return provider; },
    get nextScanAt() { return nextScanAt; },
    get config() { return cfg; },
    reloadConfig() { cfg = loadConfig(db); return cfg; },
    onEvent(fn) { events.add(fn); return () => events.delete(fn); },
    getState: k => getState(db, k),
  };
}

function sleep(ms) { return new Promise(r => { const h = setTimeout(r, ms); h.unref?.(); }); }
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => { const h = setTimeout(() => rej(new Error(`${label}: timeout na ${ms} ms`)), ms); h.unref?.(); })]);
}
