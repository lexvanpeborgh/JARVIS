// Enginestatus, uitsluitend afgeleid uit opgeslagen gebeurtenissen en de
// actuele QuoteHub — nooit uit een handmatig ingestelde boolean.

import { lastHeartbeat, getState } from '../store/db.js';
import { loadCalendar } from '../calendar/calendar.js';
import { calendarStatus } from '../core/news.js';
import { marketStatus } from '../core/sessions.js';
import { getInstrument } from '../core/instruments.js';
import { TF_MS, floorTf } from '../core/time.js';
import { loadConfig } from './config.js';

export function countMissedScans(lastOkScanAt, now, watchlist, grace = 60_000) {
  if (!lastOkScanAt) return null;
  let missed = 0;
  const first = floorTf(lastOkScanAt, 'M5') + TF_MS.M5;
  for (let b = first; b <= now - grace; b += TF_MS.M5) {
    if (watchlist.some(id => marketStatus(getInstrument(id), b).open)) missed += 1;
    if (missed > 10_000) break;
  }
  return missed;
}

export function engineStatus(db, engine, now = Date.now()) {
  const cfg = loadConfig(db);
  const eng = lastHeartbeat(db, 'engine');
  const scanOk = lastHeartbeat(db, 'scan', 'ok');
  const scanAny = lastHeartbeat(db, 'scan');
  const scanErr = lastHeartbeat(db, 'scan', 'error');
  const sched = getState(db, 'scheduler');
  const prov = getState(db, 'provider');
  const cal = loadCalendar(db, now);
  const calSt = calendarStatus(cal, now, cfg.newsPolicy);
  const tgCheck = getState(db, 'telegram.check');
  const outbox = Object.fromEntries(db.all('SELECT status, COUNT(*) n FROM outbox GROUP BY status').map(r => [r.status, r.n]));
  const hub = engine?.hub;
  const feeds = cfg.watchlist.map(id => {
    const inst = getInstrument(id);
    const m = marketStatus(inst, now, { fxHolidays: cfg.fxHolidays });
    const f = hub ? hub.freshness(id, now, cfg.limits.maxQuoteAgeSec) : { state: 'DISCONNECTED' };
    const q = hub?.get(id) || null;
    return { instrument: id, market: m, freshness: m.open ? f.state : (f.state === 'LIVE' ? 'LIVE' : 'MARKET_CLOSED'), quote: q ? { bid: q.bid, ask: q.ask, time: q.time, lastChangeAt: q.lastChangeAt, receivedAt: q.receivedAt, source: q.source, kind: q.kind } : null, quoteAgeSec: f.quoteAgeSec ?? null };
  });
  const engineAgeSec = eng ? (now - eng.at) / 1000 : null;
  const missed = countMissedScans(scanOk?.at, now, cfg.watchlist);
  const anyOpen = feeds.some(f => f.market.open);
  const lastEval = db.get('SELECT evaluated_at, state, instrument, strategy, blockers FROM evaluations ORDER BY evaluated_at DESC LIMIT 1');
  const recentSetups = db.all('SELECT state, blockers FROM evaluations WHERE evaluated_at > ? ', now - 10 * 60_000);

  const conditions = [];
  if (!eng || engineAgeSec > 60) conditions.push({ code: 'BACKGROUND_MISSED', text: 'Achtergrondcontrole gemist', severity: 'error' });
  if (prov?.problem) conditions.push({ code: 'PROVIDER_NOT_CONFIGURED', text: `Koersfeed niet gekoppeld: ${prov.problem.detail || prov.problem.text}`, severity: 'warn' });
  if (anyOpen && hub && !hub.connected && prov?.id) conditions.push({ code: 'DISCONNECTED', text: 'Verbinding met koersfeed verbroken', severity: 'error' });
  if (missed != null && missed > 0) conditions.push({ code: 'SCANS_MISSED', text: `${missed} M5-scan(s) gemist sinds de laatste geslaagde scan`, severity: missed > 2 ? 'error' : 'warn' });
  if (scanAny && scanAny.detail?.durationMs > 60_000) conditions.push({ code: 'DELAYED', text: 'Engine vertraagd', severity: 'warn' });
  if (cfg.notifications.telegramEnabled && !(tgCheck?.ok)) conditions.push({ code: 'TELEGRAM_NOT_READY', text: 'Telegram niet gereed', severity: 'warn' });
  if (!calSt.ok) conditions.push({ code: calSt.code, text: calSt.text, severity: 'warn' });

  let headline;
  if (!eng || engineAgeSec > 60) headline = { code: 'BACKGROUND_MISSED', text: 'Achtergrondcontrole gemist' };
  else if (prov?.problem) headline = { code: 'WAITING_FOR_FEED', text: 'Engine draait, wacht op koersfeed' };
  else if (!anyOpen) headline = { code: 'MARKET_CLOSED', text: 'Engine draait, markt gesloten' };
  else if (hub && !hub.connected) headline = { code: 'DISCONNECTED', text: 'Verbinding verbroken' };
  else if (missed > 0) headline = { code: 'DELAYED', text: 'Engine vertraagd' };
  else if (recentSetups.some(e => e.state === 'NO_TRADE')) headline = { code: 'ENTRY_BLOCKED', text: 'Engine draait, entry geblokkeerd' };
  else if (recentSetups.some(e => e.state === 'BUY' || e.state === 'SELL')) headline = { code: 'SETUP_ACTIVE', text: 'Engine draait, setup actief' };
  else headline = { code: 'NO_SETUP', text: 'Engine draait, geen setup' };

  return {
    now,
    mode: cfg.provider.name === 'demo' ? 'DEMO' : 'LIVE_ANALYSIS',
    modeText: cfg.provider.name === 'demo' ? 'DEMO — synthetische voorbeelddata' : `Live analyse — ${cfg.provider.env === 'live' ? 'OANDA live-data' : 'OANDA practice-data'}; geen automatische orders`,
    headline,
    conditions,
    engine: { lastHeartbeat: eng?.at ?? null, ageSec: engineAgeSec, owner: eng?.detail?.owner ?? null, leader: eng?.detail?.leader ?? null },
    scan: { lastOk: scanOk?.at ?? null, lastAttempt: scanAny?.at ?? null, lastError: scanErr ? { at: scanErr.at, detail: scanErr.detail } : null, nextScanAt: sched?.nextScanAt ?? null, missed, lastResults: scanAny?.detail?.results ?? null },
    lastEvaluation: lastEval ? { at: lastEval.evaluated_at, instrument: lastEval.instrument, strategy: lastEval.strategy, state: lastEval.state } : null,
    provider: { id: prov?.id ?? null, label: prov?.label ?? null, kind: prov?.kind ?? null, problem: prov?.problem ?? null, feedMode: hub?.mode ?? 'none', connected: hub?.connected ?? false, pollIntervalMs: hub?.pollIntervalMs ?? null, lastError: hub?.lastError ?? null, heartbeatAt: hub?.heartbeatAt ?? null, heartbeatReceivedAt: hub?.heartbeatReceivedAt ?? null, latency: hub?.latencyStats() ?? null },
    feeds,
    calendar: { status: calSt, fetchedAt: cal?.fetchedAt ?? null, coverage: cal?.coverage ?? null, source: cal?.source ?? null, coverageText: cal?.coverageText ?? null, lastAttempt: lastHeartbeat(db, 'calendar') },
    telegram: { enabled: cfg.notifications.telegramEnabled, check: tgCheck, outbox },
    latencyTargets: { quoteToBrowserMs: 1000, scanAfterCloseSec: cfg.scheduler.evalDelaySec + 10, note: 'Doelen, geen garanties. Gemeten waarden staan bij provider.latency en scan.durationMs.' },
  };
}
