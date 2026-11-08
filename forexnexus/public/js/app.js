import { h, render } from 'preact';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import htm from 'htm';
import { api, setCsrf, connectStream, cachePut, cacheGet, fmtTime, fmtUtc, ago, nf, px, setTz, STATE_UI, FRESH_UI } from './api.js';
import { TradeView } from './trade.js';
import { InstrumentView, SignalsView, SignalDetail, RiskView, MacroView, BacktestView, BacktestDetail, ReplayView, PaperView } from './views.js';

export const html = htm.bind(h);

// ---------- globale store (eenvoudig) ----------
export const store = { meta: null, status: null, quotes: {}, listeners: new Set(), online: true };
export function useStore() {
  const [, set] = useState(0);
  useEffect(() => { const f = () => set(x => x + 1); store.listeners.add(f); return () => store.listeners.delete(f); }, []);
  return store;
}
export function bump() { for (const f of store.listeners) f(); }

function useRoute() {
  const [r, setR] = useState(location.hash.slice(1) || '/');
  useEffect(() => { const f = () => setR(location.hash.slice(1) || '/'); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}

export function StateBadge({ state, big = false }) {
  const u = STATE_UI[state] || STATE_UI.NONE;
  return html`<span class=${`state ${state} ${big ? 'big' : ''}`} title=${u.long}><span aria-hidden="true">${u.sym}</span>${big ? u.long : u.text}</span>`;
}
export function Fresh({ f }) {
  const u = FRESH_UI[f] || { cls: 'warn', text: f || '—' };
  return html`<span class=${`badge ${u.cls}`}><span class="dot"></span>${u.text}</span>`;
}
export function ModeBadge() {
  const s = useStore();
  if (!s.status) return null;
  return s.status.mode === 'DEMO' ? html`<span class="badge demo">DEMO · synthetisch</span>` : html`<span class="badge ok">LIVE ANALYSE · geen orders</span>`;
}

// ---------- login ----------
function Login({ onDone }) {
  const [pw, setPw] = useState(''); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await api('/api/login', { method: 'POST', body: { password: pw } }); setCsrf(r.csrf); onDone(); }
    catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  return html`<div class="login card">
    <div class="brand"><img src="/icons/icon-192.png" alt="" />ForexNexus Alpha</div>
    <p class="muted">Privétoegang. Voer je wachtwoord in.</p>
    <form onSubmit=${submit} class="stack">
      <input class="i" type="password" autocomplete="current-password" placeholder="Wachtwoord" value=${pw} onInput=${e => setPw(e.target.value)} />
      ${err && html`<div class="note err">${err}</div>`}
      <button class="btn primary" disabled=${busy || !pw}>Aanmelden</button>
    </form>
  </div>`;
}

// ---------- shell ----------
const NAV = [
  ['/', '📈', 'Handelen'], ['/markt', '🗂', 'Overzicht'], ['/signals', '🔔', 'Signalen'], ['/risk', '🛡', 'Risicoplan'], ['/macro', '🗓', 'Macro & nieuws'],
  ['/backtest', '🧪', 'Backtestlab'], ['/replay', '⏯', 'Replay'], ['/paper', '📒', 'Paper & dagboek'], ['/status', '🩺', 'Engine & data'], ['/settings', '⚙️', 'Verbindingen'],
];
const BOTTOM = [['/', '📈', 'Handelen'], ['/signals', '🔔', 'Signalen'], ['/paper', '📒', 'Paper'], ['/status', '🩺', 'Status'], ['/settings', '⚙️', 'Meer']];

function Shell({ children, route }) {
  const s = useStore();
  const active = p => (p === '/' ? route === '/' || route.startsWith('/i/') : route.startsWith(p));
  return html`<div class="shell">
    <nav class="nav">
      <div class="brand"><img src="/icons/icon-192.png" alt="" />ForexNexus Alpha</div>
      ${NAV.map(([p, ic, t]) => html`<a href=${`#${p}`} class=${active(p) ? 'active' : ''}><span aria-hidden="true">${ic}</span>${t}</a>`)}
      <div style="padding:12px 10px" class="small faint">Geen echte orders · papertrading gesimuleerd</div>
    </nav>
    <main class="main">
      ${!s.online && html`<div class="banner offline">OFFLINE — server niet bereikbaar. Getoonde waarden zijn de laatst ontvangen gegevens met hun oorspronkelijke tijdstempel; niets hiervan is live.</div>`}
      ${children}
    </main>
    <nav class="bottomnav">${BOTTOM.map(([p, ic, t]) => html`<a href=${`#${p}`} class=${active(p) ? 'active' : ''}><span aria-hidden="true">${ic}</span><span>${t}</span></a>`)}</nav>
  </div>`;
}

// ---------- monitor ----------
function SetupChecklist({ st, meta }) {
  if (!st || !meta) return null;
  const cfg = meta.config;
  const items = [
    { ok: cfg.provider.name === 'oanda' && cfg.secrets['oanda.token'].set && !!cfg.provider.accountId, text: 'Marktdata-provider (OANDA) gekoppeld', hint: cfg.provider.name === 'demo' ? 'Nu: DEMO' : (st.provider.problem?.detail || '') },
    { ok: st.provider.connected && st.mode !== 'DEMO', text: 'Echte koersen ontvangen', hint: st.mode === 'DEMO' ? 'Synthetisch' : st.provider.feedMode },
    { ok: st.calendar.status.ok, text: 'Economische kalender actueel', hint: st.calendar.status.text },
    { ok: !!st.telegram.check?.ok && cfg.notifications.telegramEnabled, text: 'Telegram gereed', hint: st.telegram.check?.text || (cfg.notifications.telegramEnabled ? 'Nog niet getest' : 'Uitgeschakeld') },
    { ok: st.engine.ageSec != null && st.engine.ageSec < 60, text: 'Achtergrondengine actief', hint: st.engine.lastHeartbeat ? `heartbeat ${ago(st.engine.lastHeartbeat)}` : 'geen heartbeat' },
  ];
  if (items.every(i => i.ok)) return null;
  return html`<div class="card" style="margin-bottom:12px">
    <h3>Eerste installatie</h3>
    <ul class="conds">${items.map(i => html`<li class=${i.ok ? 'ok' : 'no'}><span class="ic">${i.ok ? '✔' : '✖'}</span><span><span class="lbl">${i.text}</span> <span class="det">${i.hint}</span></span></li>`)}</ul>
    <div class="row" style="margin-top:10px"><a class="btn" href="#/settings">Verbindingen instellen</a><a class="btn" href="#/backtest">Historische test starten</a></div>
  </div>`;
}

function Monitor() {
  const s = useStore();
  const [ov, setOv] = useState(() => cacheGet('overview')?.data || null);
  const [cachedAt, setCachedAt] = useState(null);
  const load = useCallback(async () => {
    try { const d = await api('/api/overview'); setOv(d); setCachedAt(null); cachePut('overview', d); }
    catch (e) { if (e.code === 'OFFLINE') { const c = cacheGet('overview'); if (c) { setOv(c.data); setCachedAt(c.savedAt); } } }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, []);
  const meta = s.meta;
  const instMeta = id => meta?.instruments.find(i => i.id === id);
  const others = meta ? meta.instruments.filter(i => !meta.config.watchlist.includes(i.id) && i.assetClass !== 'FX_SPOT') : [];
  return html`<div>
    <div class="topbar"><h1>Marktmonitor</h1><${ModeBadge} />${s.status && html`<span class="badge">${s.status.headline.text}</span>`}${cachedAt && html`<span class="badge err">Gecachet van ${fmtTime(cachedAt, { seconds: true })}</span>`}</div>
    <${SetupChecklist} st=${s.status} meta=${meta} />
    <div class="monitor">
      ${(ov || []).map(o => {
        const inst = instMeta(o.instrument) || { precision: 5 };
        const q = s.quotes[o.instrument] || o.quote;
        const feed = s.status?.feeds.find(f => f.instrument === o.instrument);
        const fresh = cachedAt ? 'DISCONNECTED' : (feed?.freshness || o.freshness?.state);
        return html`<a class="card tile" href=${`#/i/${o.instrument}`} style="color:inherit">
          <div class="row spread"><b style="font-size:16px">${o.display}</b><${Fresh} f=${fresh} /></div>
          <div class="small muted">${inst.assetLabel} · ${q ? `${q.kind === 'synthetic' ? 'synthetisch' : q.source} · quote ${fmtTime(q.time, { seconds: true })}` : 'geen quote'}</div>
          <div class="row"><span class="price">${q ? px(inst, (q.bid + q.ask) / 2) : '—'}</span><span class="small mono muted">bid ${px(inst, q?.bid)} · ask ${px(inst, q?.ask)}</span></div>
          <div class="stack" style="gap:6px">${o.evaluations.map(e => html`<div class="row spread small"><span class="muted">${meta?.strategies.find(x => x.id === e.strategy)?.name || e.strategy}</span><${StateBadge} state=${e.state} /></div>`)}
            ${!o.evaluations.length && html`<span class="small muted">Nog geen evaluatie</span>`}</div>
          ${o.activeSignals.length > 0 && html`<div class="note warn small">${o.activeSignals.length} actief signaal · verloopt ${fmtTime(o.activeSignals[0].expires_at, { seconds: true, date: false })}</div>`}
        </a>`;
      })}
      ${others.map(i => html`<div class="card tile" style="opacity:.85">
        <div class="row spread"><b style="font-size:16px">${i.display}</b><span class="badge warn">NIET GEKOPPELD</span></div>
        <div class="small muted">${i.name} · ${i.assetLabel}${i.exchange ? ` · ${i.exchange}` : ''}${i.contract ? ` · contract ${i.contract.symbol} (rol ${fmtTime(i.contract.rollAt, { date: true })})` : ''}</div>
        <div class="small">${i.assetClass === 'INDEX' ? i.note : i.feed?.text}</div>
        ${i.assetClass === 'FUTURE' && html`<div class="small mono muted">tick ${i.tick} = ${i.tickValue} USD · ${i.pointValue} USD/punt</div>`}
      </div>`)}
    </div>
  </div>`;
}

// ---------- status ----------
function Row({ k, v, sub }) { return html`<tr><th>${k}</th><td class="mono">${v}</td><td class="small muted">${sub || ''}</td></tr>`; }

function StatusView() {
  const s = useStore(); const st = s.status;
  const [hb, setHb] = useState([]); const [q, setQ] = useState([]); const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/heartbeats?kind=scan').then(setHb).catch(() => {}); api('/api/quality').then(setQ).catch(() => {}); }, [st?.scan.lastAttempt]);
  if (!st) return html`<div class="muted">Status laden…</div>`;
  const act = async p => { setBusy(true); try { await api(p, { method: 'POST' }); await refreshStatus(); } finally { setBusy(false); } };
  return html`<div class="stack">
    <div class="topbar"><h1>Engine- en datastatus</h1><${ModeBadge} /></div>
    <div class="card"><div class="row spread"><b style="font-size:16px">${st.headline.text}</b><span class="small muted">afgeleid uit opgeslagen heartbeats · ${fmtTime(st.now, { seconds: true })}</span></div>
      ${st.conditions.length ? html`<ul class="blockers" style="margin-top:10px">${st.conditions.map(c => html`<li>${c.text} <code>${c.code}</code></li>`)}</ul>` : html`<p class="muted">Geen waarschuwingen.</p>`}
      <div class="row" style="margin-top:10px"><button class="btn" disabled=${busy} onClick=${() => act('/api/engine/scan-now')}>Scan nu uitvoeren</button><button class="btn" disabled=${busy} onClick=${() => act('/api/engine/restart')}>Engine herstarten</button></div></div>
    <div class="card tablewrap"><h3>Tijdlijn</h3><table class="t"><tbody>
      <${Row} k="Laatste geslaagde achtergrondcontrole (scan)" v=${fmtTime(st.scan.lastOk, { seconds: true })} sub=${ago(st.scan.lastOk)} />
      <${Row} k="Verwachte volgende scan" v=${fmtTime(st.scan.nextScanAt, { seconds: true })} sub="exact het tijdstip dat de scheduler gebruikt (candlegrens + vertraging)" />
      <${Row} k="Gemiste scans" v=${st.scan.missed ?? '—'} sub="M5-grenzen tijdens marktopening zonder geslaagde scan" />
      <${Row} k="Laatste strategie-evaluatie" v=${fmtTime(st.lastEvaluation?.at, { seconds: true })} sub=${st.lastEvaluation ? `${st.lastEvaluation.instrument} · ${st.lastEvaluation.strategy} · ${st.lastEvaluation.state}` : ''} />
      <${Row} k="Engine-heartbeat" v=${fmtTime(st.engine.lastHeartbeat, { seconds: true })} sub=${`${ago(st.engine.lastHeartbeat)} · lease: ${st.engine.leader ? 'deze worker' : 'niet'}`} />
      <${Row} k="Provider-heartbeat" v=${fmtTime(st.provider.heartbeatAt, { seconds: true })} sub=${`ontvangen ${ago(st.provider.heartbeatReceivedAt)}`} />
      <${Row} k="Laatste fout" v=${st.scan.lastError ? fmtTime(st.scan.lastError.at, { seconds: true }) : '—'} sub=${st.scan.lastError ? JSON.stringify(st.scan.lastError.detail?.error || st.scan.lastError.detail?.results?.find(r => r.error)?.error || '') : ''} />
    </tbody></table></div>
    <div class="grid g2">
      <div class="card"><h3>Koersfeed</h3><dl class="kv">
        <dt>Provider</dt><dd>${st.provider.label || '—'}</dd>
        <dt>Transport</dt><dd>${{ stream: 'Streaming (server-side) → SSE', polling: `Live polling elke ${st.provider.pollIntervalMs / 1000} s`, demo: 'DEMO-generator (1 s)', none: 'geen' }[st.provider.feedMode]}</dd>
        <dt>Verbonden</dt><dd>${st.provider.connected ? 'ja' : 'nee'}</dd>
        <dt>Gemeten latency p50/p95</dt><dd>${st.provider.latency ? `${st.provider.latency.p50} / ${st.provider.latency.p95} ms (${st.provider.latency.samples})` : 'geen echte metingen'}</dd>
        <dt>Doel quote → browser</dt><dd>max. ${st.latencyTargets.quoteToBrowserMs} ms (doel, geen garantie)</dd>
        <dt>Laatste fout</dt><dd>${st.provider.lastError || '—'}</dd></dl>
        ${st.provider.problem && html`<div class="note warn" style="margin-top:8px">${st.provider.problem.text}: ${st.provider.problem.detail}</div>`}
      </div>
      <div class="card"><h3>Kalender & Telegram</h3><dl class="kv">
        <dt>Kalender</dt><dd>${st.calendar.status.text}</dd>
        <dt>Opgehaald</dt><dd>${fmtTime(st.calendar.fetchedAt, { seconds: true })}</dd>
        <dt>Dekking</dt><dd>${st.calendar.coverage ? `${fmtTime(st.calendar.coverage.from)} → ${fmtTime(st.calendar.coverage.to)}` : '—'}</dd>
        <dt>Telegram</dt><dd>${st.telegram.enabled ? (st.telegram.check?.ok ? `gereed (@${st.telegram.check.bot})` : 'niet gereed') : 'uit'}</dd>
        <dt>Outbox</dt><dd>${Object.entries(st.telegram.outbox).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'leeg'}</dd></dl>
        <p class="small muted">${st.calendar.coverageText}</p></div>
    </div>
    <div class="card tablewrap"><h3>Per instrument</h3><table class="t"><thead><tr><th>Instrument</th><th>Markt</th><th>Quote</th><th>Laatste quote</th><th>Laatste prijswijziging</th><th>Leeftijd</th></tr></thead><tbody>
      ${st.feeds.map(f => html`<tr><td>${f.instrument}</td><td>${f.market.text}</td><td><${Fresh} f=${f.freshness} /></td><td class="mono">${fmtTime(f.quote?.time, { seconds: true })}</td><td class="mono">${fmtTime(f.quote?.lastChangeAt, { seconds: true })}</td><td class="num">${f.quoteAgeSec == null ? '—' : nf(f.quoteAgeSec, 1) + ' s'}</td></tr>`)}
    </tbody></table></div>
    <div class="card tablewrap"><h3>Laatste scans</h3><table class="t"><thead><tr><th>Tijd</th><th>Status</th><th>Duur</th><th>Details</th></tr></thead><tbody>
      ${hb.slice(0, 20).map(x => html`<tr><td class="mono">${fmtTime(x.at, { seconds: true })}</td><td>${x.status}</td><td class="num">${x.detail?.durationMs ?? '—'} ms</td><td class="small">${(x.detail?.results || []).map(r => `${r.instrument}: ${r.error || (r.evaluations || []).map(e => e.state).join('/')}`).join(' · ') || x.detail?.reason || ''}</td></tr>`)}
    </tbody></table></div>
    <div class="card tablewrap"><h3>Datakwaliteitsmeldingen</h3>${q.length ? html`<table class="t"><tbody>${q.slice(0, 30).map(x => html`<tr><td class="mono">${fmtTime(x.at)}</td><td>${x.instrument}</td><td>${x.type}</td><td class="small">${JSON.stringify(x.detail).slice(0, 160)}</td></tr>`)}</tbody></table>` : html`<p class="muted">Geen meldingen.</p>`}</div>
  </div>`;
}

// ---------- instellingen ----------
function SecretField({ name, label, status, onSaved }) {
  const [v, setV] = useState(''); const [msg, setMsg] = useState(null);
  const save = async () => { const r = await api('/api/secrets', { method: 'POST', body: { name, value: v } }); setV(''); setMsg(r.note); onSaved(); };
  const del = async () => { if (!confirm(`${label} verwijderen?`)) return; await api('/api/secrets/delete', { method: 'POST', body: { name, confirm: true } }); onSaved(); };
  return html`<label class="f">${label} ${status?.set ? html`<span class="badge ok">opgeslagen ${status.hint}</span>` : html`<span class="badge warn">niet ingesteld</span>`}
    <div class="row"><input class="i grow" type="password" autocomplete="off" placeholder=${status?.set ? 'Leeg laten = ongewijzigd' : 'Plak hier'} value=${v} onInput=${e => setV(e.target.value)} />
    <button class="btn" type="button" disabled=${!v} onClick=${save}>Opslaan</button>${status?.set && html`<button class="btn danger" type="button" onClick=${del}>Wissen</button>`}</div>
    ${msg && html`<span class="small">${msg}</span>`}</label>`;
}

function SettingsView() {
  const s = useStore();
  const [cfg, setCfg] = useState(null); const [msg, setMsg] = useState(null); const [test, setTest] = useState({});
  const load = async () => setCfg(await api('/api/settings'));
  useEffect(() => { load(); }, []);
  if (!cfg) return html`<div class="muted">Laden…</div>`;
  const set = (path, val) => { const c = structuredClone(cfg); let o = c; const ks = path.split('.'); for (const k of ks.slice(0, -1)) o = o[k]; o[ks.at(-1)] = val; setCfg(c); };
  const save = async keys => {
    setMsg(null);
    try { const patch = Object.fromEntries(keys.map(k => [k, cfg[k]])); const r = await api('/api/settings', { method: 'POST', body: patch }); setCfg(r.config); setMsg({ ok: true, text: `Opgeslagen (configuratieversie ${r.configVersion}${r.restarted ? ', engine herstart' : ''}).` }); await loadMeta(); await refreshStatus(); }
    catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  const runTest = async which => { setTest(t => ({ ...t, [which]: { busy: true } })); try { const r = await api(`/api/connections/${which}/test`, { method: 'POST' }); setTest(t => ({ ...t, [which]: r })); } catch (e) { setTest(t => ({ ...t, [which]: { ok: false, text: e.message } })); } };
  const n = v => (v === '' || v == null ? null : Number(v));
  const strategies = s.meta?.strategies || [];
  return html`<div class="stack">
    <div class="topbar"><h1>Verbindingen en instellingen</h1></div>
    ${msg && html`<div class=${`note ${msg.ok ? '' : 'err'}`}>${msg.text}</div>`}
    <div class="card stack"><h2>Marktdata-provider</h2>
      <div class="formgrid">
        <label class="f">Provider<select class="i" value=${cfg.provider.name} onChange=${e => set('provider.name', e.target.value)}><option value="demo">DEMO (synthetisch)</option><option value="oanda">OANDA v20</option></select></label>
        <label class="f">Dataomgeving<select class="i" value=${cfg.provider.env} onChange=${e => set('provider.env', e.target.value)}><option value="practice">Practice (fxpractice)</option><option value="live">Live (fxtrade) — alleen data lezen</option></select></label>
        <label class="f">Account-ID<input class="i" value=${cfg.provider.accountId} placeholder="001-001-1234567-001" onInput=${e => set('provider.accountId', e.target.value.trim())} /></label>
      </div>
      <${SecretField} name="oanda.token" label="OANDA API-token" status=${cfg.secrets['oanda.token']} onSaved=${load} />
      <div class="row"><button class="btn primary" onClick=${() => save(['provider'])}>Provider opslaan</button><button class="btn" onClick=${() => runTest('oanda')}>Verbinding testen</button>
        ${test.oanda && !test.oanda.busy && html`<span class=${`badge ${test.oanda.ok ? 'ok' : 'err'}`}>${test.oanda.ok ? `OK · ${test.oanda.accountsVisible} account(s) · ${test.oanda.currency || ''}` : `${test.oanda.code}: ${test.oanda.text || ''}`}</span>`}</div>
      <p class="small muted">De test gebruikt alleen leesrequests (accounts, summary, pricing). Er wordt nooit een order geplaatst. Een live data-account betekent niet dat er met echt geld gehandeld wordt. OANDA-candlevolume = aantal prijsupdates (tickvolume).</p>
    </div>
    <div class="card stack"><h2>Telegram</h2>
      <${SecretField} name="telegram.token" label="Bot-token (van @BotFather)" status=${cfg.secrets['telegram.token']} onSaved=${load} />
      <div class="formgrid">
        <label class="f">Chat-ID<input class="i" value=${cfg.notifications.chatId} placeholder="123456789 of @kanaal" onInput=${e => set('notifications.chatId', e.target.value.trim())} /></label>
        <label class="f">Cooldown tussen entrymeldingen (min)<input class="i" type="number" min="0" value=${cfg.notifications.cooldownMin} onInput=${e => set('notifications.cooldownMin', n(e.target.value) ?? 0)} /></label>
      </div>
      <div class="row">${[['telegramEnabled', 'Telegram inschakelen'], ['entry', 'Entrymeldingen'], ['cancelled', 'Annulering / gemist'], ['expired', 'Verlopen entry'], ['paperExit', 'Paper-exit']].map(([k, l]) => html`<label class="chk"><input type="checkbox" checked=${cfg.notifications[k]} onChange=${e => set(`notifications.${k}`, e.target.checked)} />${l}</label>`)}</div>
      <div class="row"><button class="btn primary" onClick=${() => save(['notifications'])}>Opslaan</button><button class="btn" onClick=${() => runTest('telegram')}>Bot & chat controleren</button><button class="btn" onClick=${async () => { const r = await api('/api/telegram/test-message', { method: 'POST' }); setMsg({ ok: true, text: r.note }); }}>TEST-melding versturen</button>
        ${test.telegram && !test.telegram.busy && html`<span class=${`badge ${test.telegram.ok ? 'ok' : 'err'}`}>${test.telegram.ok ? `OK · @${test.telegram.bot} · ${test.telegram.chatType}` : `${test.telegram.code}: ${test.telegram.text || ''}`}</span>`}</div>
      <p class="small muted">Demo- en replaysignalen versturen nooit entrymeldingen. Een TEST-melding is als TEST gemarkeerd. "Verzonden" betekent dat Telegram het bericht accepteerde, niet dat het gelezen is.</p>
    </div>
    <div class="card stack"><h2>Instrumenten en strategieën</h2>
      <div class="row">${['EUR_USD', 'GBP_USD', 'USD_JPY'].map(id => html`<label class="chk"><input type="checkbox" checked=${cfg.watchlist.includes(id)} onChange=${e => set('watchlist', e.target.checked ? [...cfg.watchlist, id] : cfg.watchlist.filter(x => x !== id))} />${id.replace('_', '/')}</label>`)}</div>
      <p class="small muted">MES/ES/SPY vereisen een afzonderlijke, gelicentieerde feed en worden pas toegevoegd wanneer die gekoppeld is.</p>
      <div class="row">${strategies.map(st => html`<label class="chk"><input type="checkbox" checked=${cfg.strategies.enabled.includes(st.id)} onChange=${e => set('strategies.enabled', e.target.checked ? [...cfg.strategies.enabled, st.id] : cfg.strategies.enabled.filter(x => x !== st.id))} />${st.name} v${st.version}</label>`)}</div>
      <label class="f">Standaardstrategie in de grafiek<select class="i" value=${cfg.strategies.default} onChange=${e => set('strategies.default', e.target.value)}>${strategies.map(st => html`<option value=${st.id}>${st.name}</option>`)}</select></label>
      <label class="f">Automatische paperstrategie<select class="i" value=${cfg.paper.autoStrategy || ''} onChange=${e => set('paper.autoStrategy', e.target.value || null)}><option value="">Uit (alleen handmatig bevestigen)</option>${strategies.map(st => html`<option value=${st.id}>${st.name}</option>`)}</select></label>
      <button class="btn primary" onClick=${() => save(['watchlist', 'strategies', 'paper'])}>Opslaan</button>
    </div>
    <div class="card stack"><h2>Sessies (onderzoeksvensters)</h2>
      <div class="formgrid">${Object.entries(cfg.sessions).map(([k, w]) => html`<div class="stack" style="gap:4px"><b>${w.label}</b><span class="small muted">${w.tz}</span><div class="row"><input class="i" style="width:90px" value=${w.start} onInput=${e => set(`sessions.${k}.start`, e.target.value)} />–<input class="i" style="width:90px" value=${w.end} onInput=${e => set(`sessions.${k}.end`, e.target.value)} /></div></div>`)}</div>
      <p class="small muted">Lokale sessietijd per tijdzone (DST automatisch). De Aziatische range is een expliciete onderzoeksdefinitie, niet de hele Aziatische sessie. Deze vensters zijn geen bewezen optimale handelsuren.</p>
      <button class="btn primary" onClick=${() => save(['sessions'])}>Opslaan</button>
    </div>
    <div class="card stack"><h2>Nieuwsfilter, geldigheid en kosten</h2>
      <div class="formgrid">
        <label class="f">High-impact: minuten vooraf<input class="i" type="number" value=${cfg.newsPolicy.highImpact.before} onInput=${e => set('newsPolicy.highImpact.before', n(e.target.value))} /></label>
        <label class="f">High-impact: minuten erna<input class="i" type="number" value=${cfg.newsPolicy.highImpact.after} onInput=${e => set('newsPolicy.highImpact.after', n(e.target.value))} /></label>
        <label class="f">Rentebesluit/FOMC: vooraf<input class="i" type="number" value=${cfg.newsPolicy.rateDecision.before} onInput=${e => set('newsPolicy.rateDecision.before', n(e.target.value))} /></label>
        <label class="f">Rentebesluit/FOMC: erna<input class="i" type="number" value=${cfg.newsPolicy.rateDecision.after} onInput=${e => set('newsPolicy.rateDecision.after', n(e.target.value))} /></label>
        <label class="f">Max. quote-ouderdom (s)<input class="i" type="number" value=${cfg.limits.maxQuoteAgeSec} onInput=${e => set('limits.maxQuoteAgeSec', n(e.target.value))} /></label>
        <label class="f">Max. evaluatievertraging na close (s)<input class="i" type="number" value=${cfg.limits.maxEvalDelaySec} onInput=${e => set('limits.maxEvalDelaySec', n(e.target.value))} /></label>
        <label class="f">Entrygeldigheid (s)<input class="i" type="number" value=${cfg.limits.entryTtlSec} onInput=${e => set('limits.entryTtlSec', n(e.target.value))} /></label>
        <label class="f">Max. entryafwijking (× ATR)<input class="i" type="number" step="0.05" value=${cfg.limits.maxEntryDeviationAtr} onInput=${e => set('limits.maxEntryDeviationAtr', n(e.target.value))} /></label>
        <label class="f">Cooldown (candles)<input class="i" type="number" value=${cfg.limits.cooldownBars} onInput=${e => set('limits.cooldownBars', n(e.target.value))} /></label>
        <label class="f">Spreadmodus<select class="i" value=${cfg.costs.spreadMode} onChange=${e => set('costs.spreadMode', e.target.value)}><option value="bidask">Bid/ask uit data</option><option value="model">Spreadmodel (mid ± spread/2)</option></select></label>
        <label class="f">Slippage per zijde (pips/ticks)<input class="i" type="number" step="0.1" value=${cfg.costs.slippagePerSide} onInput=${e => set('costs.slippagePerSide', n(e.target.value))} /></label>
        <label class="f">Commissie per zijde per eenheid<input class="i" type="number" step="0.00001" value=${cfg.costs.commissionPerSidePerUnit} onInput=${e => set('costs.commissionPerSidePerUnit', n(e.target.value) ?? 0)} /></label>
      </div>
      <label class="chk"><input type="checkbox" checked=${cfg.newsPolicy.required} onChange=${e => set('newsPolicy.required', e.target.checked)} />Nieuwsfilter verplicht (ontbrekende of verouderde kalender blokkeert entries)</label>
      <p class="small muted">Blackoutvensters zijn een gekozen risicobeleid, geen bewezen optimum. Absolute spreadgrens per instrument: EUR/USD 1,5 · GBP/USD 2,0 · USD/JPY 1,5 pips; relatieve grens: spread ≤ 0,25 × ATR14.</p>
      <button class="btn primary" onClick=${() => save(['newsPolicy', 'limits', 'costs'])}>Opslaan</button>
    </div>
    <div class="card stack"><h2>Risicocalculator-gegevens</h2>
      <div class="formgrid">
        <label class="f">Rekeningvaluta<select class="i" value=${cfg.risk.accountCcy} onChange=${e => set('risk.accountCcy', e.target.value)}>${['EUR', 'USD', 'GBP', 'JPY'].map(c => html`<option>${c}</option>`)}</select></label>
        <label class="f">Saldo (of papersaldo)<input class="i" type="number" value=${cfg.risk.balance ?? ''} placeholder="niet ingevuld" onInput=${e => set('risk.balance', n(e.target.value))} /></label>
        <label class="f">Risico per trade (%)<input class="i" type="number" step="0.1" value=${cfg.risk.riskPct ?? ''} placeholder="niet ingevuld" onInput=${e => set('risk.riskPct', n(e.target.value))} /></label>
        <label class="f">of risicobedrag<input class="i" type="number" value=${cfg.risk.riskMoney ?? ''} placeholder="niet ingevuld" onInput=${e => set('risk.riskMoney', n(e.target.value))} /></label>
        <label class="f">Max. gelijktijdige paperposities<input class="i" type="number" value=${cfg.risk.maxPositions ?? ''} onInput=${e => set('risk.maxPositions', n(e.target.value))} /></label>
      </div>
      <div class="formgrid">
        <label class="f">Papersaldo (start)<input class="i" type="number" value=${cfg.paper.balance} onInput=${e => set('paper.balance', n(e.target.value))} /></label>
        <label class="f">Papervaluta<select class="i" value=${cfg.paper.currency} onChange=${e => set('paper.currency', e.target.value)}>${['EUR', 'USD', 'GBP'].map(c => html`<option>${c}</option>`)}</select></label>
        <label class="f">Paper-risico per trade (%)<input class="i" type="number" step="0.1" value=${cfg.paper.riskPct} onInput=${e => set('paper.riskPct', n(e.target.value))} /></label>
      </div>
      <p class="small muted">Het papersaldo is een zelfgekozen oefenbedrag. Voor de echte risicocalculator vul je hierboven je eigen gegevens in.</p>
      <button class="btn primary" onClick=${() => save(['risk', 'paper'])}>Opslaan</button>
    </div>
    <div class="card stack"><h2>Weergave, AI-uitleg en app-link</h2>
      <div class="formgrid">
        <label class="f">Tijdzone weergave<select class="i" value=${cfg.display.tz} onChange=${e => set('display.tz', e.target.value)}><option>Europe/Brussels</option><option>UTC</option><option>Europe/London</option><option>America/New_York</option></select></label>
        <label class="f">AI-uitleglaag<select class="i" value=${cfg.ai.provider} onChange=${e => set('ai.provider', e.target.value)}><option value="none">Uit (vaste uitleg)</option><option value="gemini">Gemini (optioneel)</option></select></label>
        <label class="f">Max. AI-aanroepen per dag<input class="i" type="number" value=${cfg.ai.maxCallsPerDay} onInput=${e => set('ai.maxCallsPerDay', n(e.target.value))} /></label>
        <label class="f">Publieke app-URL (voor links in Telegram)<input class="i" value=${cfg.appUrl} placeholder="https://…" onInput=${e => set('appUrl', e.target.value.trim())} /></label>
      </div>
      <${SecretField} name="gemini.key" label="Gemini API-key (optioneel)" status=${cfg.secrets['gemini.key']} onSaved=${load} />
      <p class="small muted">Het taalmodel verandert nooit entry, stop, target, indicatorwaarden of validiteit. Output met getallen die niet in het bewijs staan wordt verworpen; de vaste uitleg blijft altijd beschikbaar.</p>
      <button class="btn primary" onClick=${() => save(['display', 'ai', 'appUrl'])}>Opslaan</button>
    </div>
    <div class="card"><button class="btn" onClick=${async () => { await api('/api/logout', { method: 'POST' }); location.reload(); }}>Afmelden</button></div>
  </div>`;
}

// ---------- app ----------
export async function loadMeta() { store.meta = await api('/api/meta'); setTz(store.meta.config.display.tz); bump(); }
export async function refreshStatus() {
  try { store.status = await api('/api/status'); store.online = true; cachePut('status', store.status); }
  catch (e) { if (e.code === 'OFFLINE') { store.online = false; const c = cacheGet('status'); if (c && !store.status) store.status = c.data; } }
  bump();
}

function App() {
  const [auth, setAuth] = useState(null);
  const route = useRoute();
  const check = async () => {
    try { const s = await api('/api/session'); if (s.authenticated) { setCsrf(s.csrf); setAuth(true); } else setAuth(false); }
    catch { store.online = false; const c = cacheGet('status'); if (c) { store.status = c.data; setAuth('offline'); } else setAuth(false); }
  };
  useEffect(() => { check(); }, []);
  useEffect(() => {
    if (auth !== true) return undefined;
    loadMeta(); refreshStatus();
    const t = setInterval(refreshStatus, 10_000);
    const stop = connectStream({ quote: q => { store.quotes[q.instrument] = q; bump(); }, signal: () => refreshStatus(), scan: () => refreshStatus(), onOpen: () => { store.online = true; bump(); }, onError: () => { store.online = false; bump(); } });
    return () => { clearInterval(t); stop(); };
  }, [auth]);
  if (auth === null) return html`<div class="boot">Laden…</div>`;
  if (auth === false) return html`<${Login} onDone=${() => setAuth(true)} />`;
  let view;
  const m = route.match(/^\/(\w+)(?:\/([^?]+))?/);
  const [, seg, arg] = m || [];
  if (route === '/' || !seg) view = html`<${TradeView} />`;
  else if (seg === 'i') view = html`<${TradeView} id=${arg} />`;
  else if (seg === 'detail') view = html`<${InstrumentView} id=${arg} />`;
  else if (seg === 'markt') view = html`<${Monitor} />`;
  else if (seg === 'signals') view = html`<${SignalsView} />`;
  else if (seg === 'signal') view = html`<${SignalDetail} id=${arg} />`;
  else if (seg === 'risk') view = html`<${RiskView} />`;
  else if (seg === 'macro') view = html`<${MacroView} />`;
  else if (seg === 'backtest' && arg) view = html`<${BacktestDetail} id=${arg} />`;
  else if (seg === 'backtest') view = html`<${BacktestView} />`;
  else if (seg === 'replay') view = html`<${ReplayView} q=${arg || ''} />`;
  else if (seg === 'paper') view = html`<${PaperView} />`;
  else if (seg === 'status') view = html`<${StatusView} />`;
  else if (seg === 'settings') view = html`<${SettingsView} />`;
  else view = html`<div>Onbekende pagina</div>`;
  return html`<${Shell} route=${route}>${view}<//>`;
}

render(html`<${App} />`, document.getElementById('app'));

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg => {
    reg.addEventListener('updatefound', () => { const w = reg.installing; w?.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) location.reload(); }); });
  }).catch(() => {});
}
