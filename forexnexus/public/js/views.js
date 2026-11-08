import { h } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';
import { api, fmtTime, fmtUtc, ago, nf, px, STATE_UI, SIGNAL_STATUS } from './api.js';
import { createTradingChart, DEFAULT_LAYERS, LAYER_LABELS } from './chart.js';
import { store, useStore, StateBadge, Fresh, ModeBadge, refreshStatus } from './app.js';

const html = htm.bind(h);
const TF = ['M1', 'M5', 'M15', 'H1', 'H4'];
const instOf = id => store.meta?.instruments.find(i => i.id === id) || { id, display: id, precision: 5, tick: 0.00001 };
const stratName = id => store.meta?.strategies.find(s => s.id === id)?.name || id;

function useInterval(fn, ms, deps = []) { useEffect(() => { fn(); const t = setInterval(fn, ms); return () => clearInterval(t); }, deps); }

function Countdown({ until }) {
  const [, set] = useState(0);
  useEffect(() => { const t = setInterval(() => set(x => x + 1), 1000); return () => clearInterval(t); }, []);
  if (!until) return null;
  const s = Math.round((until - Date.now()) / 1000);
  return s > 0 ? html`<span class="badge warn">geldig nog ${s} s</span>` : html`<span class="badge">verlopen</span>`;
}

// ---------- uitleg- en plankaarten (gedeeld door live en signaaldetail) ----------
export function PlanCard({ d, inst, title = 'Risicoplan' }) {
  const p = d?.plan;
  if (!p) return html`<div class="card"><h3>${title}</h3><p class="muted small">Geen actief plan. Entry, stop en targets verschijnen zodra een setup bevestigd is op een gesloten candle.</p></div>`;
  const long = p.direction === 'LONG';
  const L = (k, cls, price, dist, extra) => html`<div class=${`lvl ${cls}`}><span class="k">${k}</span><span class="p">${px(inst, price)}</span><span class="d">${dist ? `${dist.value} ${dist.unit}` : ''}${extra ? html`<br />${extra}` : ''}</span></div>`;
  return html`<div class="card"><h3>${title}</h3>
    <div class="small muted" style="margin-bottom:8px">${d.entryType} · ${long ? 'BUY = longpositie openen' : 'SELL = shortpositie openen'} · entryreferentie = actuele ${long ? 'ask' : 'bid'}</div>
    <div class="levels">
      ${L(long ? 'BUY @' : 'SELL @', 'entry', p.entry, null, `max. afwijking ${p.maxEntryDeviationUnits} ${p.dist.sl.unit}`)}
      ${L('SL', 'sl', p.sl, p.dist.sl, p.money?.riskPerUnit != null ? `${nf(p.money.riskPerUnit, 5)} ${p.money.accountCcy}/eenheid` : '')}
      ${p.tp1 != null && L('TP1', 'tp', p.tp1, p.dist.tp1, `RR ${nf(p.rr.tp1.gross)} bruto · ${nf(p.rr.tp1.net)} netto${p.tp1Role === 'observation' ? ' · observatie' : ' · exit'}`)}
      ${p.tp2 != null && L('TP2', 'tp', p.tp2, p.dist.tp2, `RR ${nf(p.rr.tp2.gross)} bruto · ${nf(p.rr.tp2.net)} netto${p.exitTarget === 'tp2' ? ' · exit' : ' · observatie'}`)}
    </div>
    <div class="small muted" style="margin-top:8px">${d.exitRule}</div>
    ${d.strategy.id.startsWith('LEGACY') && html`<div class="note small" style="margin-top:8px">Legacyformules: nominale bruto RR ${d.strategy.id.endsWith('ATR4') ? '0,75 (TP1) / 2,00 (TP2)' : '0,75 (TP1) / 1,75 (TP2)'} vóór kosten en tickafronding. Geen 1:2-minimum op deze variant.</div>`}
    <div class="row" style="margin-top:8px"><span class="small">Aangemaakt ${fmtTime(d.evaluatedAt, { seconds: true })}</span><${Countdown} until=${d.expiresAt} /></div>
    ${d.invalidation && html`<div class="small" style="margin-top:6px"><b>Ongeldig wanneer:</b> ${d.invalidation}</div>`}
  </div>`;
}

export function WhyCard({ d, inst }) {
  if (!d) return null;
  return html`<div class="card"><h3>Waarom deze setup?</h3>
    <div class="small muted" style="margin-bottom:8px">${d.strategy.name} v${d.strategy.version} · ${d.timeframe} · gesloten candle ${fmtTime(d.candleTime)}–${fmtTime(d.candleCloseTime, { date: false })} (${fmtUtc(d.candleTime)})</div>
    ${d.conditions.length ? html`<ul class="conds">${d.conditions.map(c => html`<li class=${c.ok ? 'ok' : 'no'}><span class="ic" aria-label=${c.ok ? 'klopt' : 'klopt niet'}>${c.ok ? '✔' : '✖'}</span><span><span class="lbl">${c.label}</span><br /><span class="det">${c.detail}</span></span></li>`)}</ul>` : html`<p class="small muted">Geen regel actief op deze candle.</p>`}
    <div class="small" style="margin-top:8px">Regelmatchscore: <b>${d.ruleScore.passed}/${d.ruleScore.total}</b> — ${d.ruleScore.meaning}</div>
    ${d.awaiting && html`<div class="note warn small" style="margin-top:8px"><b>Afwachten:</b> ${d.awaiting}</div>`}
    <div class="kv small" style="margin-top:10px">
      <dt>Spread</dt><dd>${d.snapshot.spread ? `${d.snapshot.spread.units} ${d.snapshot.spread.unit} (${nf(d.snapshot.spread.atrFrac, 3)} × ATR)` : '—'}</dd>
      <dt>Quote-ouderdom bij evaluatie</dt><dd>${d.snapshot.quote?.ageSec != null ? `${nf(d.snapshot.quote.ageSec, 1)} s` : '—'}</dd>
      <dt>ATR14</dt><dd>${px(inst, d.snapshot.indicators.atr)}</dd>
      <dt>Sessie</dt><dd>${d.snapshot.sessionOk ? 'binnen toegestaan venster' : 'buiten toegestaan venster'} (${d.snapshot.sessions.join(', ') || 'geen'})</dd>
      <dt>Volgend relevant nieuws</dt><dd>${d.snapshot.news?.next ? `${d.snapshot.news.next.currency} ${d.snapshot.news.next.title} · over ${d.snapshot.news.minutesToNext} min` : '—'}</dd>
    </div>
  </div>`;
}

export function BlockCard({ d }) {
  if (!d) return null;
  return html`<div class="card"><h3>Waarom nog geen entry? · tegenargumenten</h3>
    ${d.blockers.length ? html`<ul class="blockers">${d.blockers.map(b => html`<li>${b.text}${b.detail ? ` — ${b.detail}` : ''} <code>${b.code}</code></li>`)}</ul>` : html`<p class="small muted">Geen blokkades.</p>`}
    ${d.against.length > 0 && html`<div style="margin-top:8px"><b class="small">Wat spreekt tegen deze setup?</b><ul class="small">${d.against.map(a => html`<li>${a}</li>`)}</ul></div>`}
    ${[...d.missing, ...d.info].length > 0 && html`<div class="small muted" style="margin-top:6px">${[...d.missing, ...d.info].join(' · ')}</div>`}
    <div class="small muted" style="margin-top:6px">Een melding wordt geannuleerd bij: verlopen entryvenster (${d.snapshot.limits.entryTtlSec} s), koers > ${d.snapshot.limits.maxEntryDeviationAtr} × ATR voorbij de entry, stop geraakt vóór entry, of een nieuwsblackout die begint.</div>
  </div>`;
}

function TestedCard({ instrument, strategy }) {
  const [m, setM] = useState(null);
  useEffect(() => { api('/api/matrix').then(setM).catch(() => {}); }, [instrument, strategy]);
  const rows = (m || []).filter(r => r.instrument === instrument && r.strategy.startsWith(`${strategy} v`));
  return html`<div class="card"><h3>Wat is er getest?</h3>
    ${rows.map(r => html`<div class="row spread small" style="margin-bottom:4px"><span>${r.newsPolicy}</span><span class=${`badge ${r.status === 'GETEST_ECHTE_DATA' ? 'ok' : r.status === 'ALLEEN_SYNTHETISCH' ? 'demo' : 'warn'}`}>${r.status.replace(/_/g, ' ')}</span></div>${r.reason && html`<div class="small muted" style="margin-bottom:6px">${r.reason}</div>`}${r.runId && html`<a class="small" href=${`#/backtest/${r.runId}`}>Rapport bekijken</a>`}`)}
  </div>`;
}

// ---------- instrumentdetail ----------
export function InstrumentView({ id }) {
  const s = useStore();
  const inst = instOf(id);
  const [tf, setTf] = useState('M5');
  const [strategy, setStrategy] = useState(null);
  const [layers, setLayers] = useState(() => { try { return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem('fnx:layers') || '{}') }; } catch { return { ...DEFAULT_LAYERS }; } });
  const [an, setAn] = useState(null); const [chartInfo, setChartInfo] = useState(null); const [hover, setHover] = useState(null); const [ai, setAi] = useState(null);
  const el = useRef(null); const chart = useRef(null);
  const strat = strategy || s.meta?.config.strategies.default;

  useEffect(() => {
    if (!el.current || !s.meta) return undefined;
    chart.current = createTradingChart(el.current, { inst, tf });
    chart.current.onCrosshair(setHover);
    chart.current.setLayers(layers);
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [id, tf, !!s.meta]);

  const load = useCallback(async () => {
    if (!s.meta || !strat) return;
    const [c, a] = await Promise.all([api(`/api/chart?instrument=${id}&tf=${tf}&strategy=${strat}&limit=500`), api(`/api/analysis?instrument=${id}&strategy=${strat}`)]);
    setChartInfo(c); setAn(a);
    const d = a.decision;
    const plan = d?.plan && ['BUY', 'SELL', 'NO_TRADE'].includes(d.state) && d.timeframe === 'M5' ? { ...d.plan, startTime: d.candleCloseTime, endTime: (d.expiresAt || d.candleCloseTime) + 30 * 300_000 } : null;
    if (!c.empty) chart.current?.setData({ ...c, plan }, { fit: true });
  }, [id, tf, strat, !!s.meta]);
  useInterval(load, 30_000, [load]);
  useEffect(() => { const q = s.quotes[id]; if (q && tf !== 'M1') chart.current?.setQuote(q); }, [s.quotes[id]]);
  useEffect(() => { chart.current?.setLayers(layers); try { localStorage.setItem('fnx:layers', JSON.stringify(layers)); } catch { /* */ } }, [layers]);

  const d = an?.decision;
  const q = s.quotes[id] || an?.quote;
  const feed = s.status?.feeds.find(f => f.instrument === id);
  const explain = async () => { setAi({ busy: true }); try { setAi(await api('/api/explain', { method: 'POST', body: { instrument: id, strategy: strat } })); } catch (e) { setAi({ error: e.message }); } };
  return html`<div>
    <div class="topbar"><a href="#/" class="btn">←</a><h1>${inst.display}</h1><span class="badge">${inst.assetLabel}</span><${ModeBadge} />${feed && html`<${Fresh} f=${feed.freshness} />`}
      ${d && html`<${StateBadge} state=${d.state} />`}</div>
    <div class="detail">
      <div class="stack">
        <div class="card chartcard">
          <div class="charthead">
            <div class="seg">${TF.map(t => html`<button class=${t === tf ? 'on' : ''} onClick=${() => setTf(t)}>${t}</button>`)}</div>
            <select class="i" style="width:auto" value=${strat} onChange=${e => setStrategy(e.target.value)}>${(s.meta?.strategies || []).map(x => html`<option value=${x.id}>${x.name} v${x.version}</option>`)}</select>
            <div class="grow"></div>
            <span class="small mono">${q ? html`bid <b>${px(inst, q.bid)}</b> · ask <b>${px(inst, q.ask)}</b> · spread ${nf((q.ask - q.bid) / (inst.pip || inst.tick), 1)}` : 'geen quote'}</span>
          </div>
          <div class="chart" ref=${el}>${hover && html`<div class="legend">O ${px(inst, hover.c.o)} H ${px(inst, hover.c.h)} L ${px(inst, hover.c.l)} C ${px(inst, hover.c.c)}${hover.c.v != null ? ` V ${hover.c.v}` : ''}${hover.emaF != null ? ` · EMA9 ${px(inst, hover.emaF)} EMA21 ${px(inst, hover.emaS)}` : ''}${hover.rsi != null ? ` · RSI ${nf(hover.rsi, 1)}` : ''}</div>`}
            ${chartInfo?.empty && html`<div class="legend" style="top:40%;left:20%">${chartInfo.text}</div>`}</div>
          <div class="charthead"><div class="layers">${Object.keys(LAYER_LABELS).map(k => html`<label><input type="checkbox" checked=${layers[k]} onChange=${e => setLayers({ ...layers, [k]: e.target.checked })} />${LAYER_LABELS[k]}</label>`)}</div></div>
          <div class="chartfoot">
            <span>Bron: <b>${chartInfo?.source?.provider || '—'}</b> · ${chartInfo?.source?.kind || ''} · prijs ${chartInfo?.source?.priceType || ''} (candles = mid van bid/ask) · volume: ${chartInfo?.source?.volumeType === 'tick_count' ? 'broker-tickvolume' : chartInfo?.source?.volumeType || '—'}</span>
            <span>Laatste quote: ${q ? `${fmtTime(q.time, { seconds: true })} (${ago(q.time)})` : '—'}</span>
            <span>Laatste prijswijziging: ${feed?.quote ? fmtTime(feed.quote.lastChangeAt, { seconds: true }) : '—'}</span>
            <span>Laatste gesloten candle: ${chartInfo?.candles?.length ? fmtTime(chartInfo.candles.filter(c => c.complete !== false).at(-1)?.t) : '—'}</span>
            <span>Laatste evaluatie: ${d ? fmtTime(d.evaluatedAt, { seconds: true }) : '—'}</span>
            <span>Grijze candle = lopend, voorlopig; telt niet mee voor signalen.</span>
            <span>Grafiek: TradingView Lightweight Charts™ (Apache-2.0).</span>
          </div>
        </div>
      </div>
      <div class="stack">
        <div class="card"><h3>Signaal</h3>
          ${d ? html`<${StateBadge} state=${d.state} big=${true} />
            <div class="small muted" style="margin-top:8px">${d.dataKind !== 'real' ? 'Synthetische data — geen live entry. ' : ''}${d.state === 'NO_TRADE' ? `Setup ${d.direction === 'LONG' ? 'long' : 'short'} herkend, maar geblokkeerd.` : ''}</div>` : html`<p class="muted">${an?.text || 'Laden…'}</p>`}
        </div>
        <${PlanCard} d=${d} inst=${inst} />
        <${WhyCard} d=${d} inst=${inst} />
        <${BlockCard} d=${d} />
        ${d && html`<div class="card"><h3>Uitleg in gewone taal</h3>
          <div class="qa">${(an.explanation || []).map(x => html`<div><b>${x.q}</b>${x.a}</div>`)}</div>
          <div class="row" style="margin-top:8px"><button class="btn" onClick=${explain} disabled=${ai?.busy}>Vraag AI-uitleg</button>${ai && !ai.busy && html`<span class="small muted">${ai.source === 'ai' ? `AI (${ai.ai.model}, ${ai.ai.latencyMs} ms, ${ai.callsToday}/${ai.limit} vandaag)` : ai.note || ai.ai?.error || ai.error}</span>`}</div>
          ${ai?.source === 'ai' && html`<div class="note small" style="margin-top:8px">${ai.ai.text}</div>`}</div>`}
        <${TestedCard} instrument=${id} strategy=${strat} />
      </div>
    </div>
  </div>`;
}

// ---------- signalen ----------
export function SignalsView() {
  const [rows, setRows] = useState(null);
  useInterval(() => api('/api/signals?limit=200').then(setRows), 15_000, []);
  return html`<div><div class="topbar"><h1>Signalen</h1><${ModeBadge} /></div>
    <div class="card tablewrap">${!rows ? 'Laden…' : !rows.length ? html`<p class="muted">Nog geen signalen. Signalen worden alleen op gesloten candles aangemaakt wanneer alle regels én alle poorten kloppen. Verwijderde of ongebruikte signalen blijven in de geschiedenis.</p>` : html`
      <table class="t"><thead><tr><th>Tijd</th><th>Instrument</th><th>Actie</th><th>Strategie</th><th>Entry</th><th>SL</th><th>TP1</th><th>TP2</th><th>RR TP2</th><th>Status</th><th>Data</th></tr></thead><tbody>
      ${rows.map(r => { const inst = instOf(r.instrument); return html`<tr class="click" onClick=${() => { location.hash = `#/signal/${r.id}`; }}><td class="mono">${fmtTime(r.created_at, { seconds: true })}</td><td>${inst.display}</td><td><${StateBadge} state=${r.direction === 'LONG' ? 'BUY' : 'SELL'} /></td><td>${stratName(r.strategy)} v${r.version}</td><td class="num">${px(inst, r.entry_ref)}</td><td class="num">${px(inst, r.sl)}</td><td class="num">${px(inst, r.tp1)}</td><td class="num">${px(inst, r.tp2)}</td><td class="num">${nf(r.plan?.rr.tp2.gross)}</td><td>${SIGNAL_STATUS[r.status] || r.status}</td><td>${r.data_kind === 'real' ? r.mode : html`<span class="badge demo">synthetisch</span>`}</td></tr>`; })}
      </tbody></table>`}</div></div>`;
}

export function SignalDetail({ id }) {
  const [s, setS] = useState(null); const [msg, setMsg] = useState(null); const [sc, setSc] = useState({});
  const load = () => api(`/api/signals/${id}`).then(setS).catch(e => setMsg(e.message));
  useEffect(() => { load(); }, [id]);
  if (!s) return html`<div class="muted">${msg || 'Laden…'}</div>`;
  const inst = instOf(s.instrument); const d = s.snapshot;
  const paper = async () => { try { const r = await api('/api/paper/open', { method: 'POST', body: { signalId: s.id } }); setMsg(r.ok ? `Paperpositie geopend @ ${px(inst, r.fill)} (${r.units} eenheden).` : `Geweigerd: ${r.code} — ${r.text}`); load(); } catch (e) { setMsg(e.message); } };
  const scenario = async () => { try { await api(`/api/signals/${s.id}/scenario`, { method: 'POST', body: sc }); load(); } catch (e) { setMsg(e.message); } };
  return html`<div class="stack">
    <div class="topbar"><a href="#/signals" class="btn">←</a><h1>${inst.display} · ${s.direction === 'LONG' ? 'BUY — longentry' : 'SELL — shortentry'}</h1><span class="badge">${SIGNAL_STATUS[s.status] || s.status}</span>${s.data_kind !== 'real' && html`<span class="badge demo">synthetisch</span>`}<span class="small mono muted">${s.id}</span></div>
    ${msg && html`<div class="note">${msg}</div>`}
    <div class="grid g2"><${PlanCard} d=${d} inst=${inst} title="Originele niveaus (onveranderlijk)" /><${WhyCard} d=${d} inst=${inst} /></div>
    <div class="grid g2"><${BlockCard} d=${d} />
      <div class="card"><h3>Lifecycle</h3><table class="t"><tbody>${s.events.map(e => html`<tr><td class="mono">${fmtTime(e.at, { seconds: true })}</td><td>${e.type}</td><td class="small">${e.detail}</td></tr>`)}</tbody></table>
        <h3 style="margin-top:12px">Afleveringen</h3>${s.deliveries.length ? html`<table class="t"><tbody>${s.deliveries.map(o => html`<tr><td>${o.kind}</td><td>${o.status}</td><td class="small">${o.last_error || ''}</td><td class="mono">${fmtTime(o.sent_at || o.updated_at, { seconds: true })}</td></tr>`)}</tbody></table>` : html`<p class="small muted">Geen Telegram-melding (demo/replay, uitgeschakeld of cooldown).</p>`}</div></div>
    <div class="grid g2">
      <div class="card stack"><h3>Paper trading</h3>
        <p class="small muted">Een Telegram-melding bewijst niet dat een positie is geopend. Bevestig hier zelf een paperentry; de app controleert eerst opnieuw of de entry nog geldig is.</p>
        <button class="btn primary" disabled=${s.status !== 'ACTIVE'} onClick=${paper}>Ik neem deze entry (paper)</button>
        ${s.orders.map(o => html`<div class="small">${o.origin} · ${o.status}${o.reason ? ` · ${o.reason}` : ''}${o.fill_price ? ` · fill ${px(inst, o.fill_price)}` : ''}</div>`)}
      </div>
      <div class="card stack"><h3>Handmatig scenario</h3>
        <p class="small muted">Wijzig niveaus om een eigen scenario door te rekenen. De originele signaalniveaus blijven ongewijzigd.</p>
        <div class="formgrid">${['sl', 'tp1', 'tp2'].map(k => html`<label class="f">${k.toUpperCase()}<input class="i" type="number" step=${inst.tick} placeholder=${px(inst, s[k])} onInput=${e => setSc({ ...sc, [k]: e.target.value === '' ? undefined : Number(e.target.value) })} /></label>`)}</div>
        <button class="btn" onClick=${scenario}>Doorrekenen</button>
        ${s.scenarios.map(x => html`<div class="note small">${fmtTime(x.createdAt)} · SL ${px(inst, x.plan.sl)} (${x.plan.dist.sl.value} ${x.plan.dist.sl.unit}) · TP2 ${px(inst, x.plan.tp2)} · RR ${x.plan.rr.tp2.gross} bruto / ${x.plan.rr.tp2.net} netto ${x.plan.valid ? '' : '· ONGELDIG: ' + x.plan.errors.join(', ')}</div>`)}
      </div>
    </div>
  </div>`;
}

// ---------- risico ----------
export function RiskView() {
  const s = useStore();
  const [f, setF] = useState({ instrument: 'EUR_USD', direction: 'LONG', entry: '', sl: '', tp1: '', tp2: '', balance: s.meta?.config.risk.balance ?? '', riskPct: s.meta?.config.risk.riskPct ?? '', riskMoney: '', accountCcy: s.meta?.config.risk.accountCcy || 'EUR' });
  const [r, setR] = useState(null); const [err, setErr] = useState(null);
  const inst = instOf(f.instrument);
  const calc = async () => { setErr(null); try { setR(await api('/api/risk/calc', { method: 'POST', body: f })); } catch (e) { setErr(e.message); } };
  const set = (k, v) => setF({ ...f, [k]: v });
  return html`<div class="stack"><div class="topbar"><h1>Risicoplan & positiegrootte</h1></div>
    <div class="card stack"><div class="formgrid">
      <label class="f">Instrument<select class="i" value=${f.instrument} onChange=${e => set('instrument', e.target.value)}>${(s.meta?.instruments || []).filter(i => i.tradable).map(i => html`<option value=${i.id}>${i.display} · ${i.assetLabel}</option>`)}</select></label>
      <label class="f">Richting<select class="i" value=${f.direction} onChange=${e => set('direction', e.target.value)}><option value="LONG">LONG (kopen)</option><option value="SHORT">SHORT (verkopen)</option></select></label>
      ${['entry', 'sl', 'tp1', 'tp2'].map(k => html`<label class="f">${k.toUpperCase()}<input class="i" type="number" step=${inst.tick} value=${f[k]} onInput=${e => set(k, e.target.value)} /></label>`)}
      <label class="f">Rekeningvaluta<select class="i" value=${f.accountCcy} onChange=${e => set('accountCcy', e.target.value)}>${['EUR', 'USD', 'GBP', 'JPY'].map(c => html`<option>${c}</option>`)}</select></label>
      <label class="f">Saldo<input class="i" type="number" value=${f.balance} onInput=${e => set('balance', e.target.value)} /></label>
      <label class="f">Risico %<input class="i" type="number" step="0.1" value=${f.riskPct} onInput=${e => set('riskPct', e.target.value)} /></label>
      <label class="f">of risicobedrag<input class="i" type="number" value=${f.riskMoney} onInput=${e => set('riskMoney', e.target.value)} /></label>
    </div><button class="btn primary" onClick=${calc} disabled=${!f.entry || !f.sl}>Bereken</button>${err && html`<div class="note err">${err}</div>`}
    <p class="small muted">Niveaus worden afgerond op geldige ticks (SL weg van de entry, targets richting de entry) waarna alles opnieuw wordt berekend. ${inst.assetClass === 'FUTURE' ? `${inst.display}: tick ${inst.tick} = ${inst.tickValue} USD per contract. ${inst.verify}` : ''}</p></div>
    ${r && html`<div class="grid g2"><${PlanCard} d=${{ plan: r.plan, entryType: 'Handmatig', strategy: { id: 'MANUAL' }, exitRule: 'Handmatig scenario' }} inst=${inst} title="Resultaat" />
      <div class="card"><h3>Positiegrootte</h3>${r.size.ok ? html`<dl class="kv"><dt>Budget</dt><dd>${nf(r.size.budget)} ${f.accountCcy}</dd><dt>Risico per ${inst.assetClass === 'FUTURE' ? 'contract' : 'eenheid'}</dt><dd>${nf(r.size.riskPerUnit, 6)}</dd><dt>Grootte</dt><dd><b>${r.size.size} ${r.size.unit}</b></dd><dt>Werkelijk risico</dt><dd>${nf(r.size.actualRisk)} ${f.accountCcy}</dd></dl>${r.size.warnings.map(w => html`<div class="note warn small">${w}</div>`)}${r.size.marginNote && html`<p class="small muted">${r.size.marginNote}</p>`}<p class="small muted">${r.size.stopNote}</p>` : html`<div class="note warn">${r.size.text}</div>`}
        ${r.plan.money.pipValuePerUnit != null && html`<p class="small">Pipwaarde: ${nf(r.plan.money.pipValuePerUnit, 6)} ${f.accountCcy} per eenheid (op basis van actuele koersen).</p>`}</div></div>`}
  </div>`;
}

// ---------- macro ----------
export function MacroView() {
  const [c, setC] = useState(null); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState(null);
  const load = () => api('/api/calendar').then(setC);
  useEffect(() => { load(); }, []);
  const refresh = async () => { setBusy(true); try { const r = await api('/api/calendar/refresh', { method: 'POST' }); setMsg(r.ok ? `${r.count} events opgehaald.` : `Fout: ${r.error}`); await load(); refreshStatus(); } finally { setBusy(false); } };
  const upload = async e => { const file = e.target.files[0]; if (!file) return; try { const r = await api('/api/calendar/import', { method: 'POST', body: file }); setMsg(`${r.imported} events geïmporteerd (${fmtTime(r.coverage.from)} → ${fmtTime(r.coverage.to)}). ${r.note}`); } catch (x) { setMsg(x.message); } };
  const st = store.status?.calendar;
  const ev = (c?.calendar?.events || []).filter(e => e.impact !== 'Low');
  const byDay = {};
  for (const e of ev) { const k = fmtTime(e.time, { date: true }).slice(0, 5); (byDay[k] ||= []).push(e); }
  return html`<div class="stack"><div class="topbar"><h1>Macro & economisch nieuws</h1>${st && html`<span class=${`badge ${st.status.ok ? 'ok' : 'warn'}`}>${st.status.text}</span>`}</div>
    ${msg && html`<div class="note">${msg}</div>`}
    <div class="card stack"><div class="row"><button class="btn" disabled=${busy} onClick=${refresh}>Kalender verversen</button><label class="btn">Historische kalender importeren (CSV)<input type="file" accept=".csv" style="display:none" onChange=${upload} /></label></div>
      <p class="small muted">Bron: ${c?.calendar?.source || '—'} · opgehaald ${fmtTime(c?.calendar?.fetchedAt, { seconds: true })} · dekking ${c?.calendar ? `${fmtTime(c.calendar.coverage.from)} → ${fmtTime(c.calendar.coverage.to)}` : '—'}. ${c?.coverageText} Gebruiksrechten van de weekfeed zijn niet formeel bevestigd; controleer besluiten bij de officiële bronnen.</p>
      <p class="small">Blackoutbeleid (gekozen, geen bewezen optimum): high-impact −${c?.policy.highImpact.before}/+${c?.policy.highImpact.after} min · rentebesluit/FOMC/persconferentie −${c?.policy.rateDecision.before}/+${c?.policy.rateDecision.after} min.</p>
      <div class="row small">${Object.entries(c?.official || {}).map(([ccy, list]) => list.map(o => html`<a href=${o.url} target="_blank" rel="noopener noreferrer">${ccy}: ${o.name}</a>`))}</div></div>
    ${Object.entries(byDay).map(([day, list]) => html`<div class="card tablewrap"><h3>${day}</h3><table class="t"><thead><tr><th>Tijd</th><th>Valuta</th><th>Impact</th><th>Publicatie</th><th>Soort</th><th>Verwacht</th><th>Vorige</th><th>Uitkomst</th></tr></thead><tbody>
      ${list.map(e => html`<tr title=${e.interpretation}><td class="mono">${fmtTime(e.time, { date: false })}</td><td>${e.currency}</td><td><span class=${`badge ${e.impact === 'High' ? 'err' : e.impact === 'Medium' ? 'warn' : ''}`}>${e.impact}</span></td><td style="white-space:normal">${e.title}<div class="small muted">${e.interpretation}</div></td><td>${e.categoryLabel}</td><td>${e.forecast || 'onbekend'}</td><td>${e.previous || 'onbekend'}</td><td>${e.actual || (e.time > Date.now() ? 'nog niet gepubliceerd' : 'niet in feed')}</td></tr>`)}
    </tbody></table></div>`)}
  </div>`;
}

// ---------- backtestlab ----------
const STATUS_CLS = { GETEST_ECHTE_DATA: 'ok', ALLEEN_SYNTHETISCH: 'demo', NIET_GETEST_GEEN_DATA: 'warn', NIET_GETEST: 'warn', GEBLOKKEERD: 'err', NIET_ONDERSTEUND: '' };

export function BacktestView() {
  const s = useStore();
  const [ds, setDs] = useState([]); const [runs, setRuns] = useState([]); const [mx, setMx] = useState([]); const [msg, setMsg] = useState(null);
  const [form, setForm] = useState({ datasetId: '', strategy: 'LEGACY_EMA_RSI_VOL', newsMode: 'off', riskPerTrade: '' });
  const [imp, setImp] = useState({ instrument: 'EUR_USD', timeframe: 'M5', volumeType: 'none', tzOffsetMinutes: 0 });
  const [oa, setOa] = useState({ instrument: 'EUR_USD', from: '2023-01-01', to: new Date().toISOString().slice(0, 10) });
  const load = async () => { const [a, b, c] = await Promise.all([api('/api/datasets'), api('/api/backtests'), api('/api/matrix')]); setDs(a); setRuns(b); setMx(c); };
  useInterval(load, 5000, []);
  const run = async () => { setMsg(null); try { const j = await api('/api/backtests', { method: 'POST', body: { ...form, riskPerTrade: form.riskPerTrade === '' ? null : Number(form.riskPerTrade) } }); setMsg(`Backtest ${j.id} gestart.`); load(); } catch (e) { setMsg(e.message); } };
  const upload = async e => { const file = e.target.files[0]; if (!file) return; setMsg('Importeren…'); try { const q = new URLSearchParams({ ...imp, filename: file.name.replace(/[^\w.\- ]/g, '_') }); const r = await api(`/api/datasets/import?${q}`, { method: 'POST', body: file }); setMsg(r.ok ? `Geïmporteerd: ${r.quality.accepted} candles, ${r.quality.rejected} afgewezen, ${r.quality.gapCount} gaten.` : (r.text || r.errors?.join('; '))); load(); } catch (x) { setMsg(x.message); } };
  const synth = async () => { const r = await api('/api/datasets/synthetic', { method: 'POST', body: { instrument: imp.instrument, months: 6 } }); setForm({ ...form, datasetId: r.datasetId }); load(); };
  const oanda = async () => { try { const j = await api('/api/datasets/oanda', { method: 'POST', body: { instrument: oa.instrument, timeframe: 'M5', from: Date.parse(oa.from), to: Date.parse(oa.to) } }); setMsg(`OANDA-import gestart (${j.id}).`); } catch (e) { setMsg(e.message); } };
  const oandaReady = s.meta?.config.provider.name === 'oanda' && s.meta?.config.secrets['oanda.token'].set;
  return html`<div class="stack"><div class="topbar"><h1>Backtestlab</h1></div>
    ${msg && html`<div class="note">${msg}</div>`}
    <div class="card"><h3>Vooraf vastgelegde evaluatie</h3><p class="small">${s.meta?.evaluation.split}</p><p class="small">${s.meta?.evaluation.acceptance}</p><p class="small">${s.meta?.evaluation.insufficient}</p>
      <p class="small muted">Candlebacktest: geen tickdata. Uitvoering op de volgende open; bij SL en TP in dezelfde candle telt SL eerst. Vragen over exacte intrabar-volgorde, queue-positie en echte slippage zijn hiermee niet precies te beantwoorden.</p></div>
    <div class="grid g2">
      <div class="card stack"><h3>Data</h3>
        <div class="formgrid"><label class="f">Instrument<select class="i" value=${imp.instrument} onChange=${e => setImp({ ...imp, instrument: e.target.value })}>${['EUR_USD', 'GBP_USD', 'USD_JPY'].map(i => html`<option value=${i}>${i}</option>`)}</select></label>
          <label class="f">Volumetype in bestand<select class="i" value=${imp.volumeType} onChange=${e => setImp({ ...imp, volumeType: e.target.value })}><option value="none">Geen volume</option><option value="tick_count">Broker-tickvolume</option><option value="exchange">Beursvolume</option><option value="proxy">Proxyvolume</option></select></label>
          <label class="f">Tijdzone-offset bestand (min t.o.v. UTC)<input class="i" type="number" value=${imp.tzOffsetMinutes} onInput=${e => setImp({ ...imp, tzOffsetMinutes: Number(e.target.value) })} /></label></div>
        <label class="btn">CSV/Parquet importeren (echte historische data)<input type="file" accept=".csv,.parquet" style="display:none" onChange=${upload} /></label>
        <div class="row"><input class="i" type="date" style="width:auto" value=${oa.from} onInput=${e => setOa({ ...oa, from: e.target.value })} /><input class="i" type="date" style="width:auto" value=${oa.to} onInput=${e => setOa({ ...oa, to: e.target.value })} /><button class="btn" disabled=${!oandaReady} onClick=${oanda}>Ophalen via OANDA (M5, bid/ask)</button></div>
        ${!oandaReady && html`<p class="small muted">OANDA niet gekoppeld: historische import via OANDA niet beschikbaar.</p>`}
        <button class="btn" onClick=${synth}>Synthetische testdataset maken (alleen softwaretest)</button>
      </div>
      <div class="card stack"><h3>Backtest starten</h3>
        <label class="f">Dataset<select class="i" value=${form.datasetId} onChange=${e => setForm({ ...form, datasetId: e.target.value })}><option value="">— kies —</option>${ds.map(d => html`<option value=${d.id}>${d.kind === 'synthetic' ? '[SYNTHETISCH] ' : '[ECHT] '}${d.instrument} ${d.timeframe} · ${fmtTime(d.from_t)} → ${fmtTime(d.to_t)} · ${d.rows} candles</option>`)}</select></label>
        <label class="f">Strategie<select class="i" value=${form.strategy} onChange=${e => setForm({ ...form, strategy: e.target.value })}>${(s.meta?.strategies || []).map(x => html`<option value=${x.id}>${x.name} v${x.version}</option>`)}</select></label>
        <label class="f">Nieuwsbeleid<select class="i" value=${form.newsMode} onChange=${e => setForm({ ...form, newsMode: e.target.value })}><option value="off">Nieuwsfilter uit</option><option value="calendar">Blackout met historische kalender</option></select></label>
        <label class="f">Risico per trade in geld (optioneel)<input class="i" type="number" value=${form.riskPerTrade} onInput=${e => setForm({ ...form, riskPerTrade: e.target.value })} /></label>
        <button class="btn primary" disabled=${!form.datasetId} onClick=${run}>Start backtest</button>
        <p class="small muted">Iedere run omvat baseline + 3 ongunstiger kostenscenario's en een parametergevoeligheid (niet gebruikt voor selectie).</p>
      </div>
    </div>
    <div class="card tablewrap"><h3>Datasets en datakwaliteit</h3><table class="t"><thead><tr><th>Soort</th><th>Instrument</th><th>Bron</th><th>Periode</th><th>Candles</th><th>Afgewezen</th><th>Gaten</th><th>Volume</th><th>Checksum</th></tr></thead><tbody>
      ${ds.map(d => html`<tr><td><span class=${`badge ${d.kind === 'real' ? 'ok' : 'demo'}`}>${d.kind === 'real' ? 'ECHT' : 'SYNTHETISCH'}</span></td><td>${d.instrument} ${d.timeframe}</td><td>${d.source}${d.filename ? ` · ${d.filename}` : ''}</td><td class="mono">${fmtTime(d.from_t)} → ${fmtTime(d.to_t)}</td><td class="num">${d.rows}</td><td class="num">${d.quality?.rejected ?? '—'}</td><td class="num">${d.quality?.gapCount ?? '—'} (${d.quality?.missingCandles ?? 0})</td><td>${d.volume_type}</td><td class="mono small">${String(d.checksum).slice(0, 10)}</td></tr>`)}
    </tbody></table></div>
    <div class="card tablewrap"><h3>Runs</h3><table class="t"><thead><tr><th>Tijd</th><th>Strategie</th><th>Data</th><th>Nieuws</th><th>Status</th><th>Trades</th><th>Expectancy</th><th>Netto R</th><th>Oordeel</th></tr></thead><tbody>
      ${runs.map(r => html`<tr class="click" onClick=${() => { if (r.status === 'DONE') location.hash = `#/backtest/${r.id}`; }}><td class="mono">${fmtTime(r.createdAt)}</td><td>${r.strategy.id} v${r.strategy.version}</td><td><span class=${`badge ${r.dataKind === 'real' ? 'ok' : 'demo'}`}>${r.dataKind === 'real' ? 'ECHT' : 'SYNTHETISCH'}</span></td><td>${r.newsMode}</td><td>${r.status}${r.error ? `: ${r.error}` : ''}</td><td class="num">${r.trades ?? '—'}</td><td class="num">${nf(r.expectancyR, 3)}</td><td class="num">${nf(r.netR)}</td><td>${r.verdict || ''}</td></tr>`)}
    </tbody></table></div>
    <div class="card tablewrap"><h3>Testmatrix — wat is er werkelijk getest?</h3><table class="t"><thead><tr><th>Strategie</th><th>Instrument</th><th>TF</th><th>Nieuwsbeleid</th><th>Kosten</th><th>Uitvoering</th><th>Status</th><th>Toelichting</th></tr></thead><tbody>
      ${mx.map(r => html`<tr><td>${r.strategy}</td><td>${r.instrument}</td><td>${r.timeframe}</td><td>${r.newsPolicy}</td><td class="small">${r.costModel}</td><td class="small">${r.execution}</td><td><span class=${`badge ${STATUS_CLS[r.status] ?? ''}`}>${r.status.replace(/_/g, ' ')}</span></td><td class="small" style="white-space:normal">${r.reason || (r.period ? `${r.period} · ${r.trades} trades · ${r.verdict}` : '')}${r.runId ? html` · <a href=${`#/backtest/${r.runId}`}>run</a>` : ''}</td></tr>`)}
    </tbody></table></div>
  </div>`;
}

function Metrics({ a }) {
  const pct = x => (x == null ? '—' : `${nf(x * 100, 1)}%`);
  return html`<dl class="kv"><dt>Trades (gescoord)</dt><dd>${a.trades}</dd><dt>Onbepaald / open aan einde</dt><dd>${a.undetermined} / ${a.openAtEnd}</dd><dt>Ambigue candles (SL eerst)</dt><dd>${a.ambiguous}</dd><dt>Winrate</dt><dd>${pct(a.winrate)}</dd><dt>Gem. winst / verlies</dt><dd>${nf(a.avgWinR)} / ${nf(a.avgLossR)} R</dd><dt>Expectancy netto / bruto</dt><dd>${nf(a.expectancyR, 3)} / ${nf(a.expectancyGrossR, 3)} R</dd><dt>Profit factor</dt><dd>${a.profitFactor ?? a.profitFactorNote}</dd><dt>Netto / bruto</dt><dd>${nf(a.netR)} / ${nf(a.grossR)} R</dd>${a.netMoney != null && html`<dt>Netto geld</dt><dd>${nf(a.netMoney)}</dd>`}<dt>Max drawdown</dt><dd>${nf(a.maxDrawdownR)} R · ${nf(a.maxDrawdownDays, 1)} d</dd><dt>Langste verliesreeks</dt><dd>${a.longestLosingStreak}</dd><dt>Holding gem./max</dt><dd>${nf(a.avgHoldingMin, 0)} / ${nf(a.maxHoldingMin, 0)} min</dd><dt>Exposure</dt><dd>${a.exposurePct == null ? '—' : `${nf(a.exposurePct)}%`}</dd><dt>Trades per maand</dt><dd>${nf(a.tradesPerMonth)}</dd></dl>`;
}

function GroupTable({ title, rows }) {
  return html`<div class="card tablewrap"><h3>${title}</h3><table class="t"><thead><tr><th>Groep</th><th>Trades</th><th>Winrate</th><th>Expectancy R</th><th>Netto R</th><th>PF</th><th>Max DD R</th></tr></thead><tbody>${rows.map(x => html`<tr><td>${x.key || x.label}</td><td class="num">${x.trades}</td><td class="num">${x.winrate == null ? '—' : nf(x.winrate * 100, 1) + '%'}</td><td class="num">${nf(x.expectancyR, 3)}</td><td class="num">${nf(x.netR)}</td><td class="num">${x.profitFactor ?? '—'}</td><td class="num">${nf(x.maxDrawdownR)}</td></tr>`)}</tbody></table></div>`;
}

export function BacktestDetail({ id }) {
  const [bt, setBt] = useState(null);
  useEffect(() => { api(`/api/backtests/${id}`).then(setBt); }, [id]);
  if (!bt) return html`<div class="muted">Laden…</div>`;
  const m = bt.metrics; const meta = bt.meta;
  if (!m) return html`<div>${bt.status} ${bt.error || ''}</div>`;
  const inst = instOf(meta.instrument);
  return html`<div class="stack">
    <div class="topbar"><a href="#/backtest" class="btn">←</a><h1>${meta.strategy.id} v${meta.strategy.version} · ${meta.instrument} ${meta.timeframe}</h1><span class=${`badge ${bt.data_kind === 'real' ? 'ok' : 'demo'}`}>${bt.data_kind === 'real' ? 'ECHTE HISTORISCHE DATA' : 'SYNTHETISCH — geen historisch bewijs'}</span>
      <a class="btn" href=${`/api/backtests/${id}/report.html`}>Rapport (HTML)</a><a class="btn" href=${`/api/backtests/${id}/trades.csv`}>Trades (CSV)</a><a class="btn" href=${`/api/backtests/${id}/report.json`}>Volledig (JSON)</a></div>
    <div class="card"><h3>Oordeel</h3><b style="font-size:16px">${m.verdict.label}</b><ul>${m.verdict.reasons.map(r => html`<li>${r.text}</li>`)}</ul><p class="small muted">${m.verdict.criteria}</p></div>
    <div class="grid g2"><div class="card"><h3>Data en aannames</h3><dl class="kv"><dt>Periode</dt><dd>${fmtUtc(Date.parse(meta.span.from))} → ${fmtUtc(Date.parse(meta.span.to))}</dd><dt>Candles / warm-up</dt><dd>${meta.candles} / ${meta.warmupBars}</dd><dt>Datagaten</dt><dd>${meta.gaps} (${meta.missingCandles} candles)</dd><dt>Prijs / volume</dt><dd>${meta.priceType} / ${meta.volumeType}</dd><dt>Nieuwsbeleid</dt><dd>${meta.newsMode === 'on' ? 'historische kalender' : 'uit'}</dd><dt>Spreadmodus / slippage</dt><dd>${meta.costs.spreadMode} / ${meta.costs.slippagePerSide}</dd><dt>Overgeslagen signalen</dt><dd>${Object.entries(meta.skippedReasons || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '0'}</dd><dt>Beslissingen met blokkade</dt><dd>${Object.entries(meta.blockerCounts || {}).map(([k, v]) => `${k}: ${v}`).join(' · ') || '0'}</dd></dl><p class="small muted">${meta.executionModel}</p></div>
      <div class="card"><h3>Resultaat (baseline-kosten)</h3><${Metrics} a=${m.all} /><p class="small">Bootstrap 90%: ${m.bootstrap ? `${m.bootstrap.lower} … ${m.bootstrap.upper} R (${m.bootstrap.method})` : 'te weinig trades'}</p><p class="small muted">${m.notComputed.map(x => x.metric).join(', ')} niet berekend: ${m.notComputed[0].reason}</p></div></div>
    <${GroupTable} title="Train / validatie / test (chronologisch)" rows=${['train', 'validation', 'test'].map(k => ({ key: k, ...m.bySplit[k] }))} />
    <${GroupTable} title="Kostenscenario's" rows=${Object.values(meta.scenarios || {})} />
    <div class="grid g2"><${GroupTable} title="Per jaar" rows=${m.byYear} /><${GroupTable} title="Per sessie" rows=${m.bySession} /></div>
    <${GroupTable} title="Per maand" rows=${m.byMonth} />
    <${GroupTable} title="Parametergevoeligheid (niet gebruikt voor selectie)" rows=${(bt.sensitivity || []).map(x => ({ ...x, key: x.label }))} />
    <div class="card tablewrap"><h3>Trades (${bt.tradeCount}) — klik om in replay te openen</h3><table class="t"><thead><tr><th>#</th><th>Signaal</th><th>Richting</th><th>Entry</th><th>SL</th><th>Target</th><th>Exit</th><th>Reden</th><th>R netto</th><th>Split</th><th>Status</th></tr></thead><tbody>
      ${bt.trades.slice(0, 500).map(t => html`<tr class="click" onClick=${() => { location.hash = `#/replay/${encodeURIComponent(bt.dataset_id)}|${meta.strategy.id}|${t.signalIndex}`; }}><td>${t.idx}</td><td class="mono">${fmtTime(t.signalT)}</td><td>${t.direction}</td><td class="num">${px(inst, t.entryFill)}</td><td class="num">${px(inst, t.plan.sl)}</td><td class="num">${px(inst, t.plan[t.plan.exitTarget])}</td><td class="num">${px(inst, t.exitPx)}</td><td>${t.exitReason}</td><td class="num">${nf(t.rNet, 2)}</td><td>${t.split}</td><td>${t.status}</td></tr>`)}
    </tbody></table></div>
  </div>`;
}

// ---------- replay ----------
export function ReplayView({ q }) {
  const s = useStore();
  const [init] = useState(() => { const [d, st, c] = decodeURIComponent(q || '').split('|'); return { datasetId: d || '', strategy: st || 'STRUCT_SWEEP_MSS', cursor: c ? Number(c) : null }; });
  const [ds, setDs] = useState([]); const [sel, setSel] = useState(init); const [data, setData] = useState(null); const [playing, setPlaying] = useState(false); const [speed, setSpeed] = useState(2); const [err, setErr] = useState(null);
  const el = useRef(null); const chart = useRef(null); const cur = useRef(init.cursor);
  useEffect(() => { api('/api/datasets').then(setDs); }, []);
  const inst = data ? instOf(data.instrument) : null;
  useEffect(() => {
    if (!el.current || !inst) return undefined;
    chart.current = createTradingChart(el.current, { inst, tf: data.tf }); chart.current.setLayers({ ema: true, plan: true, blackouts: false, structure: false });
    return () => chart.current?.destroy();
  }, [inst?.id]);
  const step = async c => {
    if (!sel.datasetId) return;
    try {
      const r = await api(`/api/replay?datasetId=${encodeURIComponent(sel.datasetId)}&strategy=${sel.strategy}${c != null ? `&cursor=${c}` : ''}`);
      cur.current = r.cursor; setData(r); setErr(null);
      const markers = [];
      for (const mk of r.markers) markers.push({ time: Math.floor(mk.t / 1000), position: mk.direction === 'LONG' ? 'belowBar' : 'aboveBar', color: mk.state === 'NO_TRADE' ? '#a371f7' : mk.direction === 'LONG' ? '#3fb68b' : '#e5534b', shape: mk.state === 'NO_TRADE' ? 'circle' : mk.direction === 'LONG' ? 'arrowUp' : 'arrowDown', text: mk.state === 'NO_TRADE' ? `NO TRADE ${mk.blockers[0] || ''}` : mk.direction === 'LONG' ? 'BUY' : 'SELL' });
      for (const t of r.trades) if (t.exitT) markers.push({ time: Math.floor(t.exitT / 1000), position: t.direction === 'LONG' ? 'aboveBar' : 'belowBar', color: '#7aa2f7', shape: 'square', text: `${t.direction === 'LONG' ? 'EXIT LONG' : 'EXIT SHORT'} ${t.exitReason} ${t.rNet?.toFixed(2)}R` });
      for (const p of r.knownPivots.slice(-12)) markers.push({ time: Math.floor(p.t / 1000), position: p.kind === 'H' ? 'aboveBar' : 'belowBar', color: 'rgba(140,155,176,.7)', shape: 'circle', size: 0.4, text: `s${p.kind}` });
      markers.sort((a, b) => a.time - b.time);
      const open = r.trades.find(t => !t.exitT);
      const plan = r.decision.plan && ['BUY', 'SELL', 'NO_TRADE'].includes(r.decision.state) ? { ...r.decision.plan, startTime: r.decision.candleCloseTime, endTime: r.decision.candleCloseTime + 20 * 300_000 } : open ? { ...open.plan, startTime: open.entryT, endTime: open.entryT + 30 * 300_000 } : null;
      chart.current?.setData({ candles: r.candles, indicators: { emaFast: r.indicators.emaFast, emaSlow: r.indicators.emaSlow, rsi: r.indicators.rsi, times: r.candles.map(c => c.t) }, overlays: { sessions: {}, levelSeries: [], blackouts: [], structure: { pivots: [], sweeps: [], breaks: [], fvgs: [] } }, signals: [], extraMarkers: markers, plan }, { fit: true });
    } catch (e) { setErr(e.message); setPlaying(false); }
  };
  useEffect(() => { if (sel.datasetId) step(cur.current); }, [sel.datasetId, sel.strategy, !!inst]);
  useEffect(() => { if (!playing) return undefined; const t = setInterval(() => step((cur.current || 0) + 1), 1000 / speed); return () => clearInterval(t); }, [playing, speed, sel]);
  const d = data?.decision;
  return html`<div class="stack"><div class="topbar"><h1>Replay</h1>${data && html`<span class=${`badge ${data.dataKind === 'real' ? 'ok' : 'demo'}`}>${data.dataKind === 'real' ? 'echte historische data' : 'synthetisch'}</span>`}<span class="badge">geen live meldingen</span></div>
    <div class="card row">
      <select class="i" style="width:auto;max-width:100%" value=${sel.datasetId} onChange=${e => { cur.current = null; setSel({ ...sel, datasetId: e.target.value }); }}><option value="">— dataset —</option>${ds.map(x => html`<option value=${x.id}>${x.kind === 'synthetic' ? '[SYNTH] ' : ''}${x.instrument} · ${fmtTime(x.from_t)} → ${fmtTime(x.to_t)}</option>`)}</select>
      <select class="i" style="width:auto" value=${sel.strategy} onChange=${e => setSel({ ...sel, strategy: e.target.value })}>${(s.meta?.strategies || []).map(x => html`<option value=${x.id}>${x.name}</option>`)}</select>
      <button class="btn" onClick=${() => step((cur.current || 1) - 1)}>◀ 1</button>
      <button class="btn primary" onClick=${() => setPlaying(!playing)}>${playing ? '⏸ Pauze' : '▶ Afspelen'}</button>
      <button class="btn" onClick=${() => step((cur.current || 0) + 1)}>1 ▶</button>
      <div class="seg">${[1, 2, 5, 10].map(x => html`<button class=${x === speed ? 'on' : ''} onClick=${() => setSpeed(x)}>${x}×</button>`)}</div>
      ${data && html`<span class="small mono">${data.cursor + 1}/${data.total} · ${fmtTime(data.candles.at(-1)?.t)}</span>`}
    </div>
    ${err && html`<div class="note err">${err}</div>`}
    ${sel.datasetId && !data && !err && html`<div class="note">Replay voorbereiden: indicatoren, structuur en backtest worden causaal berekend…</div>`}
    ${!sel.datasetId && html`<div class="note">Kies een dataset. Toekomstige candles blijven verborgen; pivots verschijnen pas wanneer ze bevestigd zijn.</div>`}
    ${data && html`<div class="small muted">Swing-markeringen (sH/sL) staan op hun oorspronkelijke candle maar verschijnen pas wanneer ze bevestigd zijn (2 candles later). Laatst bevestigd: ${data.knownPivots.length ? fmtTime(data.knownPivots.at(-1).knownAtT) : '—'}.</div>`}
    <div class="detail"><div class="card chartcard"><div class="chart" ref=${el}></div></div>
      <div class="stack">${d && html`<div class="card"><h3>Beslissing op deze candle</h3><${StateBadge} state=${d.state} big=${true} />
        <div class="small" style="margin-top:8px">Consistentie met backtest: ${data.consistency.consistent == null ? data.consistency.note : data.consistency.consistent ? '✔ identiek' : '✖ AFWIJKEND'}</div></div>
        <${PlanCard} d=${d} inst=${inst} /><${WhyCard} d=${d} inst=${inst} /><${BlockCard} d=${d} />`}</div></div>
  </div>`;
}

// ---------- paper ----------
export function PaperView() {
  const [p, setP] = useState(null); const [note, setNote] = useState(''); const [img, setImg] = useState(null); const [msg, setMsg] = useState(null);
  const load = () => api('/api/paper').then(setP);
  useInterval(load, 10_000, []);
  const close = async id => { try { await api(`/api/paper/${id}/close`, { method: 'POST' }); load(); } catch (e) { setMsg(e.message); } };
  const addNote = async () => { try { await api('/api/paper/note', { method: 'POST', body: { text: note, image: img } }); setNote(''); setImg(null); load(); } catch (e) { setMsg(e.message); } };
  const pick = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => setImg(r.result); r.readAsDataURL(f); };
  if (!p) return html`<div class="muted">Laden…</div>`;
  const closed = p.positions.filter(x => x.status === 'CLOSED');
  const sumR = closed.reduce((s, x) => s + (x.realized_r || 0), 0);
  return html`<div class="stack"><div class="topbar"><h1>Paper trading & dagboek</h1><span class="badge">gesimuleerde posities · geen echte orders</span></div>
    ${msg && html`<div class="note err">${msg}</div>`}
    <div class="card tablewrap"><h3>Posities (${closed.length} gesloten · ${nf(sumR)} R)</h3><table class="t"><thead><tr><th>Geopend</th><th>Instrument</th><th>Richting</th><th>Herkomst</th><th>Eenheden</th><th>Entry</th><th>SL</th><th>TP</th><th>Status</th><th>Exit</th><th>R</th><th>Geld</th><th></th></tr></thead><tbody>
      ${p.positions.map(x => { const inst = instOf(x.instrument); return html`<tr><td class="mono">${fmtTime(x.opened_at, { seconds: true })}</td><td>${inst.display}</td><td>${x.direction}</td><td>${x.origin === 'AUTO' ? 'automatische paperstrategie' : 'handmatig bevestigd'}</td><td class="num">${x.units}</td><td class="num">${px(inst, x.entry)}</td><td class="num">${px(inst, x.sl)}</td><td class="num">${px(inst, x.tp)}</td><td>${x.status}</td><td class="small">${x.exit_reason ? `${x.exit_reason} @ ${px(inst, x.exit_price)}` : ''}</td><td class="num">${nf(x.realized_r)}</td><td class="num">${nf(x.realized_money)}</td><td>${x.status === 'OPEN' && html`<button class="btn" onClick=${() => close(x.id)}>Sluiten</button>`} ${x.signal_id && html`<a href=${`#/signal/${x.signal_id}`}>signaal</a>`}</td></tr>`; })}
    </tbody></table></div>
    <div class="card tablewrap"><h3>Entryverzoeken (geaccepteerd en afgewezen)</h3><table class="t"><tbody>${p.orders.map(o => html`<tr><td class="mono">${fmtTime(o.requested_at, { seconds: true })}</td><td>${o.instrument}</td><td>${o.direction}</td><td>${o.origin}</td><td>${o.status}</td><td class="small">${o.reason || (o.fill_price ? `fill ${o.fill_price}` : '')}</td></tr>`)}</tbody></table></div>
    <div class="card stack"><h3>Dagboek</h3><textarea class="i" rows="3" placeholder="Notitie…" value=${note} onInput=${e => setNote(e.target.value)}></textarea>
      <div class="row"><label class="btn">Screenshot toevoegen<input type="file" accept="image/png,image/jpeg,image/webp" style="display:none" onChange=${pick} /></label>${img && html`<span class="small">afbeelding toegevoegd</span>`}<button class="btn primary" disabled=${!note} onClick=${addNote}>Opslaan</button></div>
      ${p.notes.map(n => html`<div class="note"><div class="small muted">${fmtTime(n.at, { seconds: true })}</div>${n.text}${n.attachment && html`<div><img src=${n.attachment} alt="screenshot" style="max-width:100%;margin-top:6px;border-radius:6px" /></div>`}</div>`)}
    </div>
  </div>`;
}
