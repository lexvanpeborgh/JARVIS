// Hoofdscherm: compact handelsscherm met instrumenttabs, grote grafiek, signaal met exacte
// niveaus, paper-orderpaneel en inklapbare uitleg.
import { h } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';
import { api, fmtTime, ago, nf, px, STATE_UI } from './api.js';
import { createTradingChart, DEFAULT_LAYERS, LAYER_LABELS } from './chart.js';
import { store, useStore, StateBadge, Fresh, refreshStatus, loadMeta } from './app.js';

const html = htm.bind(h);
const TF = ['M1', 'M5', 'M15', 'H1', 'H4'];
const instOf = id => store.meta?.instruments.find(i => i.id === id) || { id, display: id, precision: 5, tick: 0.00001, pip: 0.0001 };

function ConnectBar() {
  const s = useStore();
  const [tok, setTok] = useState(''); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  if (!s.status || s.status.mode !== 'DEMO') return null;
  const link = async () => {
    setBusy(true); setMsg(null);
    try { const r = await api('/api/secrets', { method: 'POST', body: { name: 'oanda.token', value: tok } }); setTok(''); setMsg(r.link?.text || r.note); await loadMeta(); await refreshStatus(); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  };
  return html`<div class="connect">
    <span><b>DEMO</b> · synthetische koersen. Echte realtime koersen: plak je OANDA API-token (gratis demo-account op oanda.com → Mijn account → API-toegang).</span>
    <input class="i" type="password" autocomplete="off" placeholder="OANDA API-token" value=${tok} onInput=${e => setTok(e.target.value)} />
    <button class="btn primary" disabled=${!tok || busy} onClick=${link}>${busy ? 'Koppelen…' : 'Koppelen'}</button>
    ${msg && html`<span class="small">${msg}</span>`}
  </div>`;
}

function Tabs({ active }) {
  const s = useStore();
  const [ov, setOv] = useState([]);
  useEffect(() => { const f = () => api('/api/overview').then(setOv).catch(() => {}); f(); const t = setInterval(f, 15000); return () => clearInterval(t); }, []);
  return html`<div class="tabs">${ov.map(o => {
    const inst = instOf(o.instrument); const q = s.quotes[o.instrument] || o.quote;
    const feed = s.status?.feeds.find(f => f.instrument === o.instrument);
    const def = o.evaluations.find(e => e.strategy === s.meta?.config.strategies.default) || o.evaluations[0];
    return html`<a class=${`tab ${o.instrument === active ? 'on' : ''}`} href=${`#/i/${o.instrument}`}>
      <span class="tabname">${o.display}</span>
      <span class="mono">${q ? px(inst, (q.bid + q.ask) / 2) : o.lastClose ? html`<span class="muted" title=${`Laatste close ${fmtTime(o.lastClose.t)}`}>${px(inst, o.lastClose.price)}</span>` : '—'}</span>
      <span class=${`dot ${feed?.freshness === 'LIVE' || feed?.freshness === 'UNCHANGED' ? 'live' : ''}`} title=${feed?.freshness || ''}></span>
      ${def && def.state !== 'NONE' && html`<span class=${`mini ${def.state}`}>${STATE_UI[def.state].text}</span>`}
    </a>`;
  })}</div>`;
}

function Levels({ d, inst }) {
  const p = d?.plan;
  if (!p) return html`<div class="small muted">${d?.awaiting || 'Geen actieve setup. Niveaus verschijnen hier en op de grafiek zodra een candle een setup bevestigt.'}</div>`;
  const row = (k, cls, price, dist, rr) => html`<tr class=${cls}><td>${k}</td><td class="num">${px(inst, price)}</td><td class="num muted">${dist ? `${dist.value} ${dist.unit}` : ''}</td><td class="num">${rr ?? ''}</td></tr>`;
  return html`<table class="lv"><tbody>
    ${row(p.direction === 'LONG' ? 'BUY' : 'SELL', 'entry', p.entry)}
    ${row('SL', 'sl', p.sl, p.dist.sl)}
    ${p.tp1 != null && row('TP1', 'tp', p.tp1, p.dist.tp1, `RR ${nf(p.rr.tp1.gross)}`)}
    ${p.tp2 != null && row('TP2', 'tp', p.tp2, p.dist.tp2, `RR ${nf(p.rr.tp2.gross)}`)}
  </tbody></table>
  <div class="small muted">Geldig tot ${fmtTime(d.expiresAt, { seconds: true, date: false })} · netto RR ${nf(p.rr[p.exitTarget].net)}</div>`;
}

function Ticket({ id, inst, onDone }) {
  const s = useStore();
  const [f, setF] = useState({ units: '', sl: '', tp: '' }); const [msg, setMsg] = useState(null); const [busy, setBusy] = useState(false);
  const [sum, setSum] = useState(null);
  const loadSum = () => api('/api/paper').then(r => setSum(r.summary)).catch(() => {});
  useEffect(() => { loadSum(); const t = setInterval(loadSum, 5000); return () => clearInterval(t); }, []);
  const q = s.quotes[id];
  const order = async dir => {
    setBusy(true); setMsg(null);
    try {
      const r = await api('/api/paper/order', { method: 'POST', body: { instrument: id, direction: dir, units: f.units || null, sl: f.sl || null, tp: f.tp || null } });
      setMsg(r.ok ? { ok: true, t: `${dir === 'LONG' ? 'Gekocht' : 'Verkocht'} ${r.units} @ ${px(inst, r.fill)} · SL ${px(inst, r.sl)} · TP ${px(inst, r.tp)}` } : { ok: false, t: r.text || r.code });
      loadSum(); onDone();
    } catch (e) { setMsg({ ok: false, t: e.message }); } finally { setBusy(false); }
  };
  return html`<div class="card tight"><div class="row spread"><h3>Papertrading</h3>${sum && html`<span class="small mono">${nf(sum.equity, 0)} ${sum.currency}${sum.unrealized ? html` <span class=${sum.unrealized >= 0 ? 'up' : 'down'}>(${sum.unrealized >= 0 ? '+' : ''}${nf(sum.unrealized, 0)})</span>` : ''}</span>`}</div>
    <div class="ticketbtns">
      <button class="btn buy" disabled=${busy} onClick=${() => order('LONG')}>KOOP<small>${q ? px(inst, q.ask) : '—'}</small></button>
      <button class="btn sell" disabled=${busy} onClick=${() => order('SHORT')}>VERKOOP<small>${q ? px(inst, q.bid) : '—'}</small></button>
    </div>
    <div class="ticketf">
      <input class="i" type="number" placeholder="Eenheden (auto)" value=${f.units} onInput=${e => setF({ ...f, units: e.target.value })} />
      <input class="i" type="number" step=${inst.tick} placeholder="SL (1,5×ATR)" value=${f.sl} onInput=${e => setF({ ...f, sl: e.target.value })} />
      <input class="i" type="number" step=${inst.tick} placeholder="TP (3×ATR)" value=${f.tp} onInput=${e => setF({ ...f, tp: e.target.value })} />
    </div>
    <div class="small muted">Auto-grootte: ${sum ? `${nf(sum.riskPct, 1)}% risico van ${nf(sum.balance, 0)} ${sum.currency} papersaldo` : '—'}. Gesimuleerd, geen echte order.</div>
    ${msg && html`<div class=${`note small ${msg.ok ? '' : 'err'}`}>${msg.t}</div>`}
  </div>`;
}

function Positions({ id, inst, tick }) {
  const s = useStore();
  const [rows, setRows] = useState([]);
  const load = () => api('/api/paper').then(r => setRows(r.positions.filter(p => p.instrument === id).slice(0, 8))).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [id, tick]);
  if (!rows.length) return null;
  const q = s.quotes[id];
  const close = async pid => { try { await api(`/api/paper/${pid}/close`, { method: 'POST' }); load(); } catch (e) { alert(e.message); } };
  return html`<div class="card tight"><h3>Posities</h3><table class="lv"><tbody>${rows.map(p => {
    const long = p.direction === 'LONG';
    const cur = q ? (long ? q.bid : q.ask) : null;
    const r = p.status === 'OPEN' && cur != null ? (long ? cur - p.entry : p.entry - cur) / Math.abs(p.entry - p.sl) : p.realized_r;
    return html`<tr><td class=${long ? 'up' : 'down'}>${long ? 'LONG' : 'SHORT'}</td><td class="num">${px(inst, p.entry)}</td><td class=${`num ${(r ?? 0) >= 0 ? 'up' : 'down'}`}>${r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`}</td><td>${p.status === 'OPEN' ? html`<button class="btn xs" onClick=${() => close(p.id)}>Sluit</button>` : html`<span class="small muted">${p.exit_reason}</span>`}</td></tr>`;
  })}</tbody></table></div>`;
}

export function TradeView({ id: idArg }) {
  const s = useStore();
  const id = idArg || s.meta?.config.watchlist[0] || 'EUR_USD';
  const inst = instOf(id);
  const [tf, setTf] = useState('M5');
  const [strategy, setStrategy] = useState(null);
  const [layers, setLayers] = useState(() => { try { return { ...DEFAULT_LAYERS, ...JSON.parse(localStorage.getItem('fnx:layers') || '{}') }; } catch { return { ...DEFAULT_LAYERS }; } });
  const [an, setAn] = useState(null); const [info, setInfo] = useState(null); const [err, setErr] = useState(null); const [hover, setHover] = useState(null); const [tick, setTick] = useState(0);
  const el = useRef(null); const chart = useRef(null);
  const strat = strategy || s.meta?.config.strategies.default;

  useEffect(() => {
    if (!el.current || !s.meta) return undefined;
    try { chart.current = createTradingChart(el.current, { inst, tf }); chart.current.onCrosshair(setHover); chart.current.setLayers(layers); setErr(null); }
    catch (e) { setErr(`Grafiek kon niet starten: ${e.message}`); }
    return () => { chart.current?.destroy(); chart.current = null; };
  }, [id, tf, !!s.meta]);

  const load = useCallback(async () => {
    if (!s.meta || !strat) return;
    try {
      const [c, a] = await Promise.all([api(`/api/chart?instrument=${id}&tf=${tf}&strategy=${strat}&limit=1500`), api(`/api/analysis?instrument=${id}&strategy=${strat}`)]);
      setInfo(c); setAn(a); setErr(c.empty ? c.text : null);
      const d = a.decision;
      const plan = d?.plan && ['BUY', 'SELL', 'NO_TRADE'].includes(d.state) ? { ...d.plan, startTime: d.candleCloseTime, endTime: (d.expiresAt || d.candleCloseTime) + 30 * 300_000 } : null;
      if (!c.empty) chart.current?.setData({ ...c, plan }, { fit: !info });
    } catch (e) { setErr(`Gegevens laden mislukt: ${e.message}`); }
  }, [id, tf, strat, !!s.meta]);
  useEffect(() => { setInfo(null); }, [id, tf]);
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t); }, [load, tick]);
  useEffect(() => { const q = s.quotes[id]; if (q && tf !== 'M1') chart.current?.setQuote(q); }, [s.quotes[id]]);
  useEffect(() => { chart.current?.setLayers(layers); try { localStorage.setItem('fnx:layers', JSON.stringify(layers)); } catch { /* */ } }, [layers]);

  const d = an?.decision; const q = s.quotes[id];
  const feed = s.status?.feeds.find(f => f.instrument === id);
  return html`<div class="trade">
    <${ConnectBar} />
    <${Tabs} active=${id} />
    <div class="tradegrid">
      <div class="card chartcard">
        <div class="charthead">
          <b>${inst.display}</b>
          ${feed && html`<${Fresh} f=${feed.freshness} />`}
          <span class="small mono muted">${q ? `${px(inst, q.bid)} / ${px(inst, q.ask)} · ${nf((q.ask - q.bid) / (inst.pip || inst.tick), 1)} pip · ${ago(q.time)}` : 'geen quote'}</span>
          <div class="grow"></div>
          <div class="seg">${TF.map(t => html`<button class=${t === tf ? 'on' : ''} onClick=${() => setTf(t)}>${t}</button>`)}</div>
          <select class="i sm" value=${strat} onChange=${e => setStrategy(e.target.value)}>${(s.meta?.strategies || []).map(x => html`<option value=${x.id}>${x.name}</option>`)}</select>
          <details class="layersdd"><summary class="btn xs">Lagen</summary><div class="ddbody">${Object.keys(LAYER_LABELS).map(k => html`<label><input type="checkbox" checked=${layers[k]} onChange=${e => setLayers({ ...layers, [k]: e.target.checked })} />${LAYER_LABELS[k]}</label>`)}</div></details>
        </div>
        <div class="chart big" ref=${el}>
          ${hover && html`<div class="legend">O ${px(inst, hover.c.o)} H ${px(inst, hover.c.h)} L ${px(inst, hover.c.l)} C ${px(inst, hover.c.c)}${hover.emaF != null ? ` · EMA9 ${px(inst, hover.emaF)} · EMA21 ${px(inst, hover.emaS)}` : ''}</div>`}
          ${err && html`<div class="charterr">${err}<br /><button class="btn xs" onClick=${() => setTick(t => t + 1)}>Opnieuw laden</button></div>`}
        </div>
        <div class="chartfoot"><span>${info?.source?.provider || '—'} · ${info?.source?.kind || ''}</span><span>Laatste candle ${info?.candles?.length ? fmtTime(info.candles.filter(c => c.complete !== false).at(-1)?.t) : '—'}</span><span>▲▼ signaal bij close (historisch berekend, nieuwsfilter uit) · grijs ▲▼ = setup geblokkeerd · ● paper · ■ exit</span><span>Grijs = lopende candle</span><span>Lightweight Charts™</span></div>
      </div>
      <div class="side">
        <div class="card tight">
          <div class="row spread">${d ? html`<${StateBadge} state=${d.state} />` : html`<span class="muted small">Laden…</span>`}<span class="small muted">${d ? fmtTime(d.candleTime, { date: false }) : ''}</span></div>
          <div style="margin-top:8px"><${Levels} d=${d} inst=${inst} /></div>
          ${d?.blockers?.length > 0 && d.state !== 'NONE' && html`<div class="small blocktxt">⛔ ${d.blockers.map(b => b.text).join(' · ')}</div>`}
          ${d && html`<details class="why"><summary>Waarom?</summary>
            <ul class="conds">${d.conditions.map(c => html`<li class=${c.ok ? 'ok' : 'no'}><span class="ic">${c.ok ? '✔' : '✖'}</span><span><span class="lbl">${c.label}</span><br /><span class="det">${c.detail}</span></span></li>`)}</ul>
            ${d.blockers.length > 0 && html`<ul class="blockers">${d.blockers.map(b => html`<li>${b.text}${b.detail ? ` — ${b.detail}` : ''}</li>`)}</ul>`}
            ${d.against.length > 0 && html`<div class="small">Tegen: ${d.against.join(' · ')}</div>`}
            <div class="small muted">${d.ruleScore.passed}/${d.ruleScore.total} regels kloppen (geen winstkans) · ${d.exitRule}</div>
          </details>`}
        </div>
        <${Ticket} id=${id} inst=${inst} onDone=${() => setTick(t => t + 1)} />
        <${Positions} id=${id} inst=${inst} tick=${tick} />
      </div>
    </div>
  </div>`;
}
