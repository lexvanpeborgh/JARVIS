// Servicelaag tussen HTTP en kernlogica: grafiekdata, backtestjobs,
// rapporten, testmatrix en replay.

import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getInstrument, INSTRUMENTS, ASSET, ASSET_LABEL, frontContract } from '../core/instruments.js';
import { getStrategy, STRATEGIES } from '../core/strategies/index.js';
import { prepareSeries, evaluate } from '../core/evaluate.js';
import { aggregate } from '../core/quality.js';
import { windowIntervals, DEFAULT_SESSIONS } from '../core/sessions.js';
import { blackouts, currenciesFor } from '../core/news.js';
import { TF_MS, iso } from '../core/time.js';
import { runBacktest } from '../backtest/engine.js';
import { loadCandles, upsertCandles } from '../store/db.js';
import { loadCalendar, calendarForRange } from '../calendar/calendar.js';
import { syntheticCandles } from '../data/providers/demo.js';
import { loadConfig } from '../engine/config.js';
import { liveDatasetId } from '../engine/engine.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------- grafiek ----------

export function chartData(db, { instrument, tf = 'M5', strategyId, limit = 600, datasetId = null, upto = null }) {
  const cfg = loadConfig(db);
  const inst = getInstrument(instrument);
  const strat = getStrategy(strategyId || cfg.strategies.default);
  const ds = datasetId || liveDatasetId(cfg);
  const baseTf = 'M5';
  const factor = TF_MS[tf] / TF_MS[baseTf];
  if (!TF_MS[tf]) throw new Error('Ongeldig tijdframe');
  let base;
  if (tf === 'M1') base = loadCandles(db, ds, instrument, 'M1', { limit, to: upto ?? 8.64e15 });
  else base = loadCandles(db, ds, instrument, baseTf, { limit: Math.min(20_000, Math.max(limit, 300) * Math.max(1, factor)), to: upto ?? 8.64e15 });
  const dsRow = db.get('SELECT * FROM datasets WHERE id = ?', ds);
  if (!base.length) return { instrument, tf, candles: [], datasetId: ds, empty: true, source: sourceInfo(cfg, dsRow, inst), text: tf === 'M1' ? 'M1 is niet opgeslagen voor deze bron (de engine bewaart M5).' : 'Nog geen candles ontvangen.' };
  const candles = tf === 'M1' || tf === baseTf ? base : aggregate(base, baseTf, tf);
  // de laatste geaggregeerde bucket kan nog lopen: markeren als onvolledig
  if (tf !== baseTf && tf !== 'M1' && candles.length) {
    const last = candles.at(-1);
    const end = last.t + TF_MS[tf];
    const lastBaseClose = base.at(-1).t + TF_MS[baseTf];
    if (lastBaseClose < end) last.complete = false;
  }
  const view = candles.slice(-limit);
  const series = prepareSeries(view.filter(c => c.complete !== false), inst, tf, strat, { withStructure: true, sessions: cfg.sessions });
  const from = view[0].t; const to = view.at(-1).t + TF_MS[tf];
  const cal = loadCalendar(db, Date.now());
  const bos = cal ? blackouts(cal.events, currenciesFor(inst), cfg.newsPolicy).filter(b => b.end > from && b.start < to + 86_400_000) : [];
  const st = series.structure;
  const signals = db.all('SELECT id, direction, status, candle_t, strategy, version, entry_ref, sl, tp1, tp2, expires_at, created_at, mode, data_kind FROM signals WHERE instrument = ? AND candle_t >= ? ORDER BY candle_t', instrument, from);
  const sigEvents = signals.length ? db.all(`SELECT * FROM signal_events WHERE signal_id IN (${signals.map(() => '?').join(',')}) ORDER BY at`, ...signals.map(s => s.id)) : [];
  const n = series.candles.length;
  return {
    instrument, display: inst.display, tf, datasetId: ds,
    source: sourceInfo(cfg, dsRow, inst),
    candles: view,
    indicators: { emaFast: series.ind.emaFast, emaSlow: series.ind.emaSlow, rsi: series.ind.rsi, atr: series.ind.atr, times: series.candles.map(c => c.t) },
    overlays: {
      sessions: Object.fromEntries(Object.entries(cfg.sessions).map(([k, w]) => [k, windowIntervals(w, from, to).map(b => ({ ...b, label: w.label }))])),
      levels: n ? st.levels[n - 1] : null,
      levelSeries: st.levels.map((l, k) => ({ t: series.candles[k].t, pdh: l.pdh, pdl: l.pdl, asianHigh: l.asianHigh, asianLow: l.asianLow })),
      structure: {
        pivots: [...st.pivots.highs.map(p => ({ ...p, kind: 'H' })), ...st.pivots.lows.map(p => ({ ...p, kind: 'L' }))].map(p => ({ t: p.t, knownAtT: series.candles[p.knownAt]?.t ?? null, price: p.price, kind: p.kind })),
        breaks: st.breaks.map(b => ({ type: b.type, t: b.t, level: b.level })),
        sweeps: st.sweeps.map(s => ({ type: s.type, level: s.level, t: s.t, price: s.price })),
        fvgs: st.fvgs.filter(g => g.invalidatedAt == null).slice(-30).map(g => ({ type: g.type, t: g.t, top: g.top, bottom: g.bottom })),
        orderBlocks: st.orderBlocks.filter(o => o.invalidatedAt == null).slice(-10).map(o => ({ type: o.type, t: o.t, top: o.top, bottom: o.bottom })),
      },
      blackouts: bos.map(b => ({ start: b.start, end: b.end, title: b.event.title, currency: b.event.currency, rule: b.rule })),
    },
    signals: signals.map(s => ({ ...s, events: sigEvents.filter(e => e.signal_id === s.id).map(e => ({ type: e.type, at: e.at })) })),
  };
}

export function sourceInfo(cfg, dsRow, inst) {
  const isDemo = !dsRow ? cfg.provider.name === 'demo' : dsRow.kind === 'synthetic' || dsRow.id === 'live:demo';
  const contract = inst.assetClass === ASSET.FUTURE ? frontContract(inst, Date.now()) : null;
  return {
    provider: isDemo ? 'DEMO' : (dsRow?.provider || dsRow?.source || cfg.provider.name),
    kind: isDemo ? 'SYNTHETISCH' : (dsRow?.id?.startsWith('live:') ? 'ACTUEEL (zie quote-actualiteit)' : 'HISTORISCH'),
    priceType: dsRow?.price_type || (isDemo ? 'BA' : 'BA'),
    volumeType: dsRow?.volume_type || (isDemo ? 'synthetic' : 'tick_count'),
    assetClass: ASSET_LABEL[inst.assetClass], contract,
  };
}

// ---------- datasets ----------

/** Synthetische dataset (expliciet als zodanig opgeslagen) voor technische tests. */
export function ensureSyntheticDataset(db, instrument, months = 6) {
  const id = `synthetic:${instrument}:M5:${months}m`;
  if (db.get('SELECT id FROM datasets WHERE id = ?', id)) return id;
  const to = Date.UTC(2026, 0, 5) + months * 30 * 86_400_000;
  const c = syntheticCandles(instrument, 'M5', Date.UTC(2026, 0, 5), to);
  db.run('INSERT INTO datasets (id, source, provider, instrument, timeframe, price_type, volume_type, timezone, from_t, to_t, rows, checksum, kind, filename, corrections, quality, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, 'demo', 'demo', instrument, 'M5', 'BA', 'synthetic', 'UTC', c[0].t, c.at(-1).t, c.length, 'synthetic', 'synthetic', null, '[]', JSON.stringify({ note: 'Synthetische random-walkdata. Geen historisch bewijs.' }), Date.now());
  upsertCandles(db, id, instrument, 'M5', c);
  return id;
}

export function listDatasets(db) {
  return db.all('SELECT id, source, provider, instrument, contract, timeframe, price_type, volume_type, timezone, from_t, to_t, rows, checksum, kind, filename, imported_at, quality FROM datasets ORDER BY imported_at DESC')
    .map(r => ({ ...r, quality: r.quality ? summarizeQuality(JSON.parse(r.quality)) : null }));
}

function summarizeQuality(q) {
  return { accepted: q.accepted, rejected: q.rejected, gapCount: q.gapCount, missingCandles: q.missingCandles, counts: q.counts, ok: q.ok, note: q.note };
}

// ---------- backtests ----------

const jobs = new Map();
export function getJob(id) { return jobs.get(id) || null; }

export function startBacktest(db, { datasetId, strategyId, newsMode = 'off', riskPerTrade = null }) {
  const ds = db.get('SELECT * FROM datasets WHERE id = ?', datasetId);
  if (!ds) throw new Error('Dataset niet gevonden');
  const strategy = getStrategy(strategyId);
  if (!strategy.instruments.includes(ds.instrument)) throw new Error(`${strategy.id} is niet gedefinieerd voor ${ds.instrument}`);
  if (!strategy.timeframes.includes(ds.timeframe)) throw new Error(`${strategy.id} is niet gedefinieerd voor ${ds.timeframe}`);
  const quality = ds.quality ? JSON.parse(ds.quality) : null;
  if (quality && quality.accepted === 0) throw new Error('Dataset bevat geen geldige candles');
  const candles = loadCandles(db, datasetId, ds.instrument, ds.timeframe, { limit: 2_000_000 });
  const cfg = loadConfig(db);
  let calendar = null;
  if (newsMode === 'calendar') {
    calendar = calendarForRange(db, candles[0].t, candles.at(-1).t);
    if (!calendar) throw new Error('Geen historische kalender die de volledige periode dekt. Importeer eerst een kalender of kies "nieuwsfilter uit".');
  }
  const id = `bt_${randomUUID().slice(0, 12)}`;
  const config = { datasetId, strategy: { id: strategy.id, version: strategy.version, params: strategy.params }, newsMode, riskPerTrade, costs: cfg.costs, sessions: cfg.sessions, limits: cfg.limits, accountCcy: cfg.risk.accountCcy };
  db.run('INSERT INTO backtest_runs (id, created_at, dataset_id, data_kind, status, config) VALUES (?,?,?,?,?,?)', id, Date.now(), datasetId, ds.kind, 'RUNNING', JSON.stringify(config));
  const job = { id, status: 'RUNNING', startedAt: Date.now() };
  jobs.set(id, job);
  const w = new Worker(join(HERE, '..', 'backtest', 'worker.js'), {
    workerData: { candles, instrument: ds.instrument, strategyId, opts: { tf: ds.timeframe, costs: cfg.costs, sessions: cfg.sessions, limits: cfg.limits, newsMode: newsMode === 'calendar' ? 'on' : 'off', calendar, accountCcy: cfg.risk.accountCcy, riskPerTrade, meta: { datasetId, dataKind: ds.kind, datasetSource: ds.source, priceType: ds.price_type, volumeType: ds.volume_type } } },
  });
  w.once('message', msg => {
    if (!msg.ok) { db.run("UPDATE backtest_runs SET status='FAILED', error=? WHERE id=?", msg.error, id); job.status = 'FAILED'; job.error = msg.error; return; }
    const r = msg.result;
    db.tx(() => {
      db.run("UPDATE backtest_runs SET status='DONE', meta=?, metrics=?, sensitivity=? WHERE id=?", JSON.stringify({ ...r.meta, scenarios: r.scenarios, skipped: r.skipped.length, skippedReasons: countBy(r.skipped, s => s.reason), decisions: r.decisions.length, blockerCounts: blockerCounts(r.decisions) }), JSON.stringify(r.metrics), JSON.stringify(r.sensitivity), id);
      r.trades.forEach((t, k) => db.run('INSERT INTO backtest_trades (run_id, idx, json) VALUES (?,?,?)', id, k, JSON.stringify(t)));
      r.skipped.forEach((t, k) => db.run('INSERT INTO backtest_trades (run_id, idx, json) VALUES (?,?,?)', id, 1_000_000 + k, JSON.stringify({ ...t, status: 'SKIPPED' })));
    });
    job.status = 'DONE';
  });
  w.once('error', e => { db.run("UPDATE backtest_runs SET status='FAILED', error=? WHERE id=?", e.message, id); job.status = 'FAILED'; job.error = e.message; });
  return job;
}

function countBy(a, f) { const o = {}; for (const x of a) { const k = f(x); o[k] = (o[k] || 0) + 1; } return o; }
function blockerCounts(decisions) { const o = {}; for (const d of decisions) for (const b of d.blockers) o[b] = (o[b] || 0) + 1; return o; }

export function getBacktest(db, id) {
  const r = db.get('SELECT * FROM backtest_runs WHERE id = ?', id);
  if (!r) return null;
  const rows = db.all('SELECT idx, json FROM backtest_trades WHERE run_id = ? ORDER BY idx', id).map(x => ({ idx: x.idx, ...JSON.parse(x.json) }));
  return { ...r, config: JSON.parse(r.config), meta: r.meta ? JSON.parse(r.meta) : null, metrics: r.metrics ? JSON.parse(r.metrics) : null, sensitivity: r.sensitivity ? JSON.parse(r.sensitivity) : null, trades: rows.filter(x => x.status !== 'SKIPPED'), skipped: rows.filter(x => x.status === 'SKIPPED') };
}

export function listBacktests(db) {
  return db.all('SELECT id, created_at, dataset_id, data_kind, status, config, metrics, error FROM backtest_runs ORDER BY created_at DESC LIMIT 100').map(r => {
    const m = r.metrics ? JSON.parse(r.metrics) : null; const c = JSON.parse(r.config);
    return { id: r.id, createdAt: r.created_at, datasetId: r.dataset_id, dataKind: r.data_kind, status: r.status, error: r.error, strategy: c.strategy, newsMode: c.newsMode, trades: m?.all?.trades ?? null, expectancyR: m?.all?.expectancyR ?? null, netR: m?.all?.netR ?? null, verdict: m?.verdict?.label ?? null };
  });
}

export function tradesCsv(bt) {
  const cols = ['idx', 'status', 'direction', 'signalT', 'entryT', 'entryFill', 'entryRef', 'sl', 'tp', 'exitT', 'exitPx', 'exitReason', 'rGross', 'rNet', 'pnlPerUnit', 'holdingMin', 'ambiguous', 'split', 'sessions', 'reason'];
  const rows = [...bt.trades, ...bt.skipped].map(t => [t.idx, t.status, t.direction, iso(t.signalT), iso(t.entryT), t.entryFill, t.entryRef, t.plan?.sl, t.plan?.[t.plan?.exitTarget], iso(t.exitT), t.exitPx, t.exitReason, t.rGross, t.rNet, t.pnlPerUnit, t.holdingMin, t.ambiguous, t.split, (t.sessions || []).join('+'), t.reason || '']);
  const esc = v => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...rows.map(r => r.map(esc).join(','))].join('\n');
}

export function reportHtml(bt) {
  const m = bt.metrics; const meta = bt.meta; const a = m.all;
  const e = s => String(s ?? '—').replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const kindBanner = bt.data_kind === 'synthetic' ? '<p class="warn">SYNTHETISCHE DATA — technische test, geen historisch bewijs.</p>' : '';
  const row = (k, v) => `<tr><th>${e(k)}</th><td>${e(v)}</td></tr>`;
  const tbl = (title, list) => `<h2>${e(title)}</h2><table><tr><th>Groep</th><th>Trades</th><th>Winrate</th><th>Expectancy R</th><th>Netto R</th><th>PF</th><th>Max DD R</th></tr>${list.map(x => `<tr><td>${e(x.key)}</td><td>${x.trades}</td><td>${x.winrate == null ? '—' : (x.winrate * 100).toFixed(1) + '%'}</td><td>${e(x.expectancyR)}</td><td>${e(x.netR)}</td><td>${e(x.profitFactor)}</td><td>${e(x.maxDrawdownR)}</td></tr>`).join('')}</table>`;
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Backtestrapport ${e(bt.id)}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:14px system-ui;margin:24px;max-width:1000px;color:#111;background:#fff}table{border-collapse:collapse;margin:8px 0 20px;width:100%}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}.warn{background:#fff3cd;padding:8px;border:1px solid #e0c060}.verdict{font-weight:700}</style></head><body>
<h1>Backtestrapport — ${e(meta.strategy.id)} v${e(meta.strategy.version)} · ${e(meta.instrument)} ${e(meta.timeframe)}</h1>${kindBanner}
<p class="verdict">Oordeel: ${e(m.verdict.label)}</p><ul>${m.verdict.reasons.map(r => `<li>${e(r.text)}</li>`).join('')}</ul><p>Criteria (vooraf vastgelegd): ${e(m.verdict.criteria)}</p>
<h2>Data en aannames</h2><table>${row('Dataset', meta.datasetId)}${row('Soort data', bt.data_kind === 'real' ? 'Echte historische data' : 'Synthetisch')}${row('Periode', `${meta.span.from} → ${meta.span.to}`)}${row('Candles', meta.candles)}${row('Warm-up uitgesloten (candles)', meta.warmupBars)}${row('Datagaten', `${meta.gaps} (${meta.missingCandles} candles)`)}${row('Prijssoort / volume', `${meta.priceType} / ${meta.volumeType}`)}${row('Uitvoeringsmodel', meta.executionModel)}${row('Kosten', JSON.stringify(meta.costs))}${row('Nieuwsbeleid', meta.newsMode === 'on' ? 'Historische kalender' : 'Nieuwsfilter uit (geen historische kalender)')}${row('Splits', `train ${meta.splits.trainFrom} · validatie ${meta.splits.valFrom} · test ${meta.splits.testFrom}`)}${row('Overgeslagen signalen', JSON.stringify(meta.skippedReasons))}</table>
<h2>Resultaat (baseline-kosten)</h2><table>${row('Trades (gescoord)', a.trades)}${row('Onbepaald (datagat) / open aan einde', `${a.undetermined} / ${a.openAtEnd}`)}${row('Ambigue candles (SL eerst)', a.ambiguous)}${row('Winrate', a.winrate == null ? '—' : (a.winrate * 100).toFixed(1) + '%')}${row('Gem. winst / verlies (R)', `${a.avgWinR} / ${a.avgLossR}`)}${row('Expectancy netto / bruto (R)', `${a.expectancyR} / ${a.expectancyGrossR}`)}${row('Profit factor', a.profitFactor ?? a.profitFactorNote)}${row('Netto R / bruto R', `${a.netR} / ${a.grossR}`)}${row('Max drawdown (R) / duur (dagen)', `${a.maxDrawdownR} / ${a.maxDrawdownDays}`)}${row('Langste verliesreeks', a.longestLosingStreak)}${row('Holding gem./max (min)', `${a.avgHoldingMin} / ${a.maxHoldingMin}`)}${row('Exposure', a.exposurePct == null ? '—' : a.exposurePct + '%')}${row('Trades per maand', a.tradesPerMonth)}${row('Bootstrap 90%-interval expectancy', m.bootstrap ? `${m.bootstrap.lower} … ${m.bootstrap.upper} R (${m.bootstrap.method}, blok ${m.bootstrap.block})` : 'Te weinig trades')}${row('Niet berekend', m.notComputed.map(x => x.metric).join(', ') + ' — ' + m.notComputed[0].reason)}</table>
${tbl('Train / validatie / test', ['train', 'validation', 'test'].map(k => ({ key: k, ...m.bySplit[k] })))}
${tbl('Kostenscenario\'s', Object.entries(meta.scenarios || {}).map(([k, v]) => ({ key: v.label, ...v })))}
${tbl('Per jaar', m.byYear)}${tbl('Per maand', m.byMonth)}${tbl('Per sessie', m.bySession)}${tbl('Per richting', m.byDirection)}
${tbl('Parametergevoeligheid (niet gebruikt voor selectie)', (bt.sensitivity || []).map(s => ({ key: s.label, ...s })))}
<p>Gegenereerd door ForexNexus Alpha. Geen beleggingsadvies; resultaten uit het verleden zijn geen garantie.</p></body></html>`;
}

// ---------- testmatrix ----------

export function testMatrix(db) {
  const cfg = loadConfig(db);
  const runs = db.all("SELECT id, dataset_id, data_kind, config, metrics FROM backtest_runs WHERE status = 'DONE'").map(r => ({ ...r, config: JSON.parse(r.config), metrics: r.metrics ? JSON.parse(r.metrics) : null }));
  const datasets = db.all('SELECT id, instrument, timeframe, kind, from_t, to_t, rows FROM datasets');
  const hasHistCal = !!db.get("SELECT value FROM settings WHERE key = 'calendar.importCoverage'");
  const rows = [];
  const insts = ['EUR_USD', 'GBP_USD', 'USD_JPY', 'MES', 'ES', 'SPY'];
  for (const s of Object.values(STRATEGIES)) for (const inst of insts) for (const news of ['off', 'calendar']) {
    const tf = 'M5';
    const base = { strategy: `${s.id} v${s.version}`, instrument: inst, timeframe: tf, newsPolicy: news === 'off' ? 'Nieuwsfilter uit' : 'Blackout (historische kalender)', costModel: `${cfg.costs.spreadMode} + slippage ${cfg.costs.slippagePerSide}`, execution: 'Candle, volgende open', sessions: s.sessions.join('+') };
    if (!s.instruments.includes(inst)) {
      const ins = INSTRUMENTS[inst];
      rows.push({ ...base, status: ins.assetClass === 'FX_SPOT' ? 'NIET_ONDERSTEUND' : 'GEBLOKKEERD', reason: ins.assetClass === 'FX_SPOT' ? 'Niet in strategiedefinitie' : 'Forex-regels worden niet automatisch op futures/ETF toegepast; bovendien geen gelicentieerde futures/ETF-data gekoppeld' });
      continue;
    }
    const realRuns = runs.filter(r => r.config.strategy.id === s.id && r.config.newsMode === news && datasets.find(d => d.id === r.dataset_id && d.instrument === inst && d.kind === 'real'));
    const synthRuns = runs.filter(r => r.config.strategy.id === s.id && r.config.newsMode === news && datasets.find(d => d.id === r.dataset_id && d.instrument === inst && d.kind === 'synthetic'));
    const realData = datasets.filter(d => d.instrument === inst && d.kind === 'real' && d.timeframe === tf);
    if (realRuns.length) {
      const r = realRuns.at(-1); const d = datasets.find(x => x.id === r.dataset_id);
      rows.push({ ...base, status: 'GETEST_ECHTE_DATA', runId: r.id, period: `${iso(d.from_t)} → ${iso(d.to_t)}`, trades: r.metrics?.all?.trades, verdict: r.metrics?.verdict?.label });
    } else if (news === 'calendar' && !hasHistCal) {
      rows.push({ ...base, status: 'GEBLOKKEERD', reason: 'Geen historische economische kalender geïmporteerd', synthetic: synthRuns.length ? synthRuns.at(-1).id : null });
    } else if (!realData.length) {
      rows.push({ ...base, status: synthRuns.length ? 'ALLEEN_SYNTHETISCH' : 'NIET_GETEST_GEEN_DATA', reason: cfg.provider.name === 'oanda' ? 'Nog geen historische import uitgevoerd' : 'Geen echte historische data: OANDA niet gekoppeld en geen CSV/Parquet geïmporteerd', runId: synthRuns.at(-1)?.id ?? null });
    } else {
      rows.push({ ...base, status: synthRuns.length ? 'ALLEEN_SYNTHETISCH' : 'NIET_GETEST', reason: 'Echte data aanwezig maar nog geen run', runId: synthRuns.at(-1)?.id ?? null });
    }
  }
  return rows;
}

// ---------- replay ----------

const replayCache = new Map();

/**
 * Replay: dezelfde evaluate() als live en backtest, candle voor candle.
 * Alleen candles t/m `cursor` en informatie met knownAt ≤ cursor worden teruggegeven.
 */
export function replayStep(db, { datasetId, strategyId, cursor, window = 300 }) {
  const ds = db.get('SELECT * FROM datasets WHERE id = ?', datasetId);
  if (!ds) throw new Error('Dataset niet gevonden');
  const key = `${datasetId}|${strategyId}`;
  let cache = replayCache.get(key);
  const cfg = loadConfig(db);
  const inst = getInstrument(ds.instrument); const strat = getStrategy(strategyId);
  if (!cache) {
    const candles = loadCandles(db, datasetId, ds.instrument, ds.timeframe, { limit: 200_000 });
    const series = prepareSeries(candles, inst, ds.timeframe, strat, { withStructure: true, sessions: cfg.sessions });
    const bt = runBacktest({ candles, inst, tf: ds.timeframe, strategy: strat, costs: cfg.costs, sessions: cfg.sessions, limits: cfg.limits, accountCcy: cfg.risk.accountCcy });
    cache = { candles, series, bt, decisions: new Map(bt.decisions.map(d => [d.index, d])) };
    replayCache.set(key, cache);
    if (replayCache.size > 4) replayCache.delete(replayCache.keys().next().value);
  }
  const n = cache.candles.length;
  const cur = Math.max(1, Math.min(n - 1, Number.isFinite(cursor) ? cursor : strat.minHistory + 50));
  const step = TF_MS[ds.timeframe];
  const c = cache.candles[cur];
  // beslissing op de cursor met dezelfde omgeving als de backtest
  const half = (c.a && c.b) ? null : (cfg.costs.modelSpread?.[inst.id] ?? 1) * (inst.pip || inst.tick) / 2;
  const quote = c.a && c.b ? { bid: c.b.c, ask: c.a.c, time: c.t + step } : { bid: c.c - half, ask: c.c + half, time: c.t + step };
  // zelfde toestand als de backtest op dit moment: laatste BUY/SELL vóór de cursor
  let lastSig = null;
  for (const x of cache.bt.decisions) if ((x.state === 'BUY' || x.state === 'SELL') && x.index < cur) lastSig = x.index;
  const inPosition = cache.bt.trades.some(t => t.entryIndex <= cur && t.exitIndex > cur);
  const d = evaluate(cache.series, cur, strat, { mode: 'replay', now: c.t + step, quote, costs: cfg.costs, sessions: cfg.sessions, limits: cfg.limits, newsMode: 'off', state: { lastSignalIndex: lastSig }, accountCcy: cfg.risk.accountCcy });
  const btAt = cache.decisions.get(cur) || null;
  const consistent = inPosition ? null : (btAt ? btAt.state === d.state : !['BUY', 'SELL', 'NO_TRADE'].includes(d.state));
  const from = Math.max(0, cur - window + 1);
  const ct = c.t;
  const st = cache.series.structure;
  return {
    datasetId, instrument: inst.id, display: inst.display, tf: ds.timeframe, dataKind: ds.kind, total: n, cursor: cur, minHistory: strat.minHistory,
    candles: cache.candles.slice(from, cur + 1),
    indicators: { emaFast: cache.series.ind.emaFast.slice(from, cur + 1), emaSlow: cache.series.ind.emaSlow.slice(from, cur + 1), rsi: cache.series.ind.rsi.slice(from, cur + 1) },
    decision: d,
    markers: cache.bt.decisions.filter(x => x.index <= cur && x.index >= from).map(x => ({ t: x.t, state: x.state, direction: x.direction, blockers: x.blockers })),
    trades: cache.bt.trades.filter(t => t.entryT <= ct + step && t.signalIndex >= from).map(t => ({ ...t, exitT: t.exitT <= ct ? t.exitT : null, exitPx: t.exitT <= ct ? t.exitPx : null, exitReason: t.exitT <= ct ? t.exitReason : null, rNet: t.exitT <= ct ? t.rNet : null })),
    knownPivots: [...st.pivots.highs, ...st.pivots.lows].filter(p => p.knownAt <= cur && p.index >= from).map(p => ({ t: p.t, price: p.price, knownAtT: cache.candles[p.knownAt].t, kind: st.pivots.highs.includes(p) ? 'H' : 'L' })),
    consistency: { backtestDecisionAtCursor: btAt, replayState: d.state, inPosition, consistent, note: inPosition ? 'Backtest had hier een open positie en evalueerde niet (uitvoeringsmodel: max. 1 positie).' : null },
  };
}

export const SESSIONS_DEFAULT = DEFAULT_SESSIONS;
