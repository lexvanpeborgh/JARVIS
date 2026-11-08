// HTTP-server (node:http, zonder framework). Privétoegang met wachtwoord,
// sessiecookie (HttpOnly, SameSite=Strict), CSRF-token op muterende requests,
// begrensde requestgroottes en strikte inputvalidatie.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getInstrument, INSTRUMENTS, ASSET_LABEL, frontContract, fmtPrice } from '../core/instruments.js';
import { STRATEGIES, strategyCard, getStrategy, EVALUATION_CRITERIA } from '../core/strategies/index.js';
import { REASONS } from '../core/reasons.js';
import { STRUCTURE_DEFINITIONS } from '../core/structure.js';
import { INDICATOR_SPEC } from '../core/indicators.js';
import { buildPlan, positionSize } from '../core/risk.js';
import { CATEGORY_LABEL, interpretation, OFFICIAL_SOURCES } from '../core/news.js';
import { TIMEFRAMES } from '../core/time.js';
import { createSession, getSession, destroySession, parseCookies, verifyPassword, verifyWorkerRequest, redact } from './security.js';
import { loadConfig, saveConfig } from '../engine/config.js';
import { engineStatus } from '../engine/status.js';
import { getState, setState, heartbeat } from '../store/db.js';
import { checkTelegram, enqueue } from '../notify/telegram.js';
import { createOandaProvider } from '../data/providers/oanda.js';
import { createUnconfiguredFuturesProvider } from '../data/providers/futures.js';
import { refreshCalendar, loadCalendar, CALENDAR_COVERAGE_TEXT } from '../calendar/calendar.js';
import { importDataset, registerProviderDataset, parseCsv } from '../data/import.js';
import { chartData, ensureSyntheticDataset, listDatasets, startBacktest, getBacktest, listBacktests, tradesCsv, reportHtml, testMatrix, replayStep, getJob } from './services.js';
import { templateExplanation, evidenceObject, aiExplanation } from '../explain/explain.js';
import { createHash, randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(ROOT, 'public');
const VENDOR = {
  '/vendor/lightweight-charts.mjs': join(ROOT, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.mjs'),
  '/vendor/preact.mjs': join(ROOT, 'node_modules', 'preact', 'dist', 'preact.module.js'),
  '/vendor/preact-hooks.mjs': join(ROOT, 'node_modules', 'preact', 'hooks', 'dist', 'hooks.module.js'),
  '/vendor/htm.mjs': join(ROOT, 'node_modules', 'htm', 'dist', 'htm.module.js'),
};
const CORE_DIR = join(ROOT, 'src', 'core');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const SECRET_NAMES = ['oanda.token', 'telegram.token', 'gemini.key'];

// CSP-hash van de (enige) inline import map in index.html — geen 'unsafe-inline'.
function importMapHash() {
  try {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
    return m ? `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'` : '';
  } catch { return ''; }
}
const IMPORTMAP_HASH = importMapHash();

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export function createApp({ db, engine, secrets, env = process.env, log = console, fetchImpl = fetch }) {
  const loginFails = new Map();
  const sseClients = new Set();
  const cookieSecure = env.FNX_COOKIE_SECURE === '1';
  const passwordRef = () => env.FNX_ACCESS_PASSWORD_HASH || env.FNX_ACCESS_PASSWORD || getState(db, 'auth.passwordHash');

  engine?.onEvent((type, data) => {
    const payload = type === 'quote' ? { instrument: data.instrument, bid: data.bid, ask: data.ask, time: data.time, receivedAt: data.receivedAt, source: data.source, kind: data.kind } : data;
    const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of sseClients) {
      if (type === 'quote') { const last = c.lastQuote.get(data.instrument) || 0; if (Date.now() - last < 250) continue; c.lastQuote.set(data.instrument, Date.now()); }
      if (c.res.writableLength > 256_000) continue; // backpressure: trage client overslaan
      c.res.write(msg);
    }
  });

  function send(res, status, body, headers = {}) {
    const isStr = typeof body === 'string' || Buffer.isBuffer(body);
    res.writeHead(status, { 'content-type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...securityHeaders(), ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  }

  function securityHeaders() {
    return {
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
      'content-security-policy': `default-src 'self'; script-src 'self' ${IMPORTMAP_HASH}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...(cookieSecure ? { 'strict-transport-security': 'max-age=31536000' } : {}),
    };
  }

  async function readBody(req, max = 200_000) {
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > max) throw new HttpError(413, 'Request te groot'); chunks.push(ch); }
    return Buffer.concat(chunks);
  }
  async function readJson(req, max) {
    const b = await readBody(req, max);
    if (!b.length) return {};
    try { const j = JSON.parse(b.toString('utf8')); if (typeof j !== 'object' || j === null || Array.isArray(j)) throw new Error(); return j; } catch { throw new HttpError(400, 'Ongeldige JSON'); }
  }

  /**
   * Lokale desktopmodus (FNX_LOCAL_APP=1, alleen gebonden aan 127.0.0.1): geen wachtwoord nodig
   * voor verzoeken van deze pc zelf. Host-header moet loopback zijn (tegen DNS-rebinding) en
   * een eventuele Origin moet overeenkomen.
   */
  function localAppRequest(req) {
    if (env.FNX_LOCAL_APP !== '1' || env.FNX_HOST !== '127.0.0.1') return false;
    const ip = req.socket.remoteAddress || '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return false;
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== host) return false;
    return true;
  }

  function auth(req) {
    const sid = parseCookies(req.headers.cookie).fnx_sid;
    const s = getSession(db, sid);
    return s ? { sid, session: s } : null;
  }

  function requireCsrf(req, a) {
    if (req.headers['x-csrf-token'] !== a.session.csrf) throw new HttpError(403, 'CSRF-token ongeldig', 'CSRF');
    const origin = req.headers.origin;
    if (origin && req.headers.host && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Ongeldige origin', 'ORIGIN');
  }

  const str = (v, max = 200, re = null) => { if (v == null) return null; const s = String(v); if (s.length > max || (re && !re.test(s))) throw new HttpError(400, 'Ongeldige invoer'); return s; };
  const num = (v, { min = -Infinity, max = Infinity, nullable = true } = {}) => { if (v == null || v === '') { if (nullable) return null; throw new HttpError(400, 'Getal vereist'); } const n = Number(v); if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, 'Ongeldig getal'); return n; };
  const instId = v => { const s = str(v, 20, /^[A-Z_]+$/); if (!INSTRUMENTS[s]) throw new HttpError(400, 'Onbekend instrument'); return s; };
  const stratId = v => { const s = str(v || loadConfig(db).strategies.default, 60, /^[A-Z0-9_]+$/); if (!STRATEGIES[s]) throw new HttpError(400, 'Onbekende strategie'); return s; };

  function publicConfig() {
    const cfg = loadConfig(db);
    return { ...cfg, secrets: Object.fromEntries(SECRET_NAMES.map(n => [n, secrets.status()[n] || { set: false }])) };
  }

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:([a-z]+)/gi, '(?<$1>[^/]+)')}$`), handler, ...opts });

  // ---------- openbaar ----------
  route('GET', '/api/health', () => ({ ok: true, service: 'forexnexus-alpha', time: Date.now() }), { public: true });
  route('GET', '/api/session', (req, res) => {
    let a = auth(req);
    if (!a && localAppRequest(req)) {
      const s = createSession(db);
      res.setHeader('set-cookie', `fnx_sid=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}`);
      return { authenticated: true, csrf: s.csrf, localApp: true };
    }
    return { authenticated: !!a, csrf: a?.session.csrf || null, passwordConfigured: !!passwordRef(), localApp: false };
  }, { public: true });
  route('POST', '/api/login', async (req, res) => {
    const ip = req.socket.remoteAddress || 'x';
    const f = loginFails.get(ip) || { n: 0, until: 0 };
    if (f.until > Date.now()) throw new HttpError(429, 'Te veel pogingen; probeer later opnieuw');
    const { password } = await readJson(req, 2000);
    if (!verifyPassword(password || '', passwordRef())) {
      f.n += 1; if (f.n >= 5) { f.until = Date.now() + 15 * 60_000; f.n = 0; } loginFails.set(ip, f);
      throw new HttpError(401, 'Onjuist wachtwoord');
    }
    loginFails.delete(ip);
    const s = createSession(db);
    res.setHeader('set-cookie', `fnx_sid=${s.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${cookieSecure ? '; Secure' : ''}`);
    return { ok: true, csrf: s.csrf };
  }, { public: true });
  route('POST', '/api/worker/tick', async (req) => {
    const body = (await readBody(req, 10_000)).toString('utf8');
    const v = verifyWorkerRequest(db, env.FNX_WORKER_SECRET, { method: 'POST', path: '/api/worker/tick', body, headers: req.headers });
    if (!v.ok) throw new HttpError(401, `Worker-authenticatie geweigerd (${v.code})`, v.code);
    heartbeat(db, 'worker_tick', 'ok', { from: 'external' });
    const st = engineStatus(db, engine);
    return { ok: true, headline: st.headline, missedScans: st.scan.missed, engineAgeSec: st.engine.ageSec };
  }, { public: true });

  // ---------- sessie ----------
  route('POST', '/api/logout', (req, res, a) => { destroySession(db, a.sid); res.setHeader('set-cookie', 'fnx_sid=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'); return { ok: true }; });

  // ---------- status en meta ----------
  route('GET', '/api/status', () => engineStatus(db, engine));
  route('GET', '/api/meta', () => {
    const fut = createUnconfiguredFuturesProvider().status();
    return {
      instruments: Object.values(INSTRUMENTS).map(i => ({ ...i, assetLabel: ASSET_LABEL[i.assetClass], contract: i.assetClass === 'FUTURE' ? frontContract(i, Date.now()) : null, feed: i.assetClass === 'FUTURE' || i.assetClass === 'ETF' || i.assetClass === 'INDEX' ? fut : null })),
      strategies: Object.values(STRATEGIES).map(strategyCard),
      timeframes: TIMEFRAMES, reasons: REASONS, structure: STRUCTURE_DEFINITIONS, indicators: INDICATOR_SPEC, evaluation: EVALUATION_CRITERIA,
      config: publicConfig(), calendarCoverage: CALENDAR_COVERAGE_TEXT, officialSources: OFFICIAL_SOURCES,
    };
  });

  // ---------- grafiek + analyse ----------
  route('GET', '/api/chart', (req, res, a, q) => chartData(db, { instrument: instId(q.get('instrument')), tf: str(q.get('tf') || 'M5', 4, /^(M1|M5|M15|H1|H4)$/), strategyId: stratId(q.get('strategy')), limit: num(q.get('limit'), { min: 50, max: 3000 }) || 500 }));
  route('GET', '/api/analysis', (req, res, a, q) => {
    const id = instId(q.get('instrument')); const sid = stratId(q.get('strategy'));
    const row = db.get('SELECT * FROM evaluations WHERE instrument = ? AND strategy = ? ORDER BY candle_t DESC, evaluated_at DESC LIMIT 1', id, sid);
    if (!row) return { instrument: id, strategy: sid, decision: null, text: 'Nog geen evaluatie uitgevoerd.' };
    const d = JSON.parse(row.decision);
    return { instrument: id, strategy: sid, decision: d, explanation: templateExplanation(d, getInstrument(id)), quote: engine?.hub.get(id) || null, freshness: engine?.hub.freshness(id, Date.now(), loadConfig(db).limits.maxQuoteAgeSec) || null };
  });
  route('GET', '/api/overview', () => {
    const cfg = loadConfig(db);
    return cfg.watchlist.map(id => {
      const evals = cfg.strategies.enabled.map(sid => db.get('SELECT state, direction, candle_t, evaluated_at, blockers, strategy FROM evaluations WHERE instrument = ? AND strategy = ? ORDER BY candle_t DESC LIMIT 1', id, sid)).filter(Boolean).map(e => ({ ...e, blockers: JSON.parse(e.blockers || '[]') }));
      const q = engine?.hub.get(id) || null;
      const lc = db.get('SELECT c, t FROM candles WHERE instrument = ? AND timeframe = ? ORDER BY t DESC LIMIT 1', id, 'M5');
      return { instrument: id, display: INSTRUMENTS[id].display, quote: q, lastClose: lc ? { price: lc.c, t: lc.t } : null, freshness: engine?.hub.freshness(id, Date.now(), cfg.limits.maxQuoteAgeSec) || null, evaluations: evals, activeSignals: db.all("SELECT id, direction, strategy, status, expires_at FROM signals WHERE instrument = ? AND status = 'ACTIVE'", id) };
    });
  });
  route('POST', '/api/explain', async (req) => {
    const { instrument, strategy } = await readJson(req, 2000);
    const id = instId(instrument); const sid = stratId(strategy);
    const row = db.get('SELECT decision FROM evaluations WHERE instrument = ? AND strategy = ? ORDER BY candle_t DESC LIMIT 1', id, sid);
    if (!row) throw new HttpError(404, 'Geen evaluatie');
    const d = JSON.parse(row.decision); const inst = getInstrument(id);
    const template = templateExplanation(d, inst);
    const cfg = loadConfig(db);
    const key = secrets.get('gemini.key');
    if (cfg.ai.provider !== 'gemini' || !key) return { source: 'template', template, ai: null, note: 'Geen taalmodel ingeschakeld; vaste uitleg.' };
    const day = new Date().toISOString().slice(0, 10);
    const usage = getState(db, 'ai.usage') || {};
    if ((usage[day] || 0) >= cfg.ai.maxCallsPerDay) return { source: 'template', template, ai: null, note: 'Daglimiet voor AI-uitleg bereikt.' };
    setState(db, 'ai.usage', { [day]: (usage[day] || 0) + 1 });
    const r = await aiExplanation(evidenceObject(d, inst), { apiKey: key, model: cfg.ai.model, fetchImpl });
    return { source: r.ok ? 'ai' : 'template', template, ai: r.ok ? { text: r.text, latencyMs: r.latencyMs, usage: r.usage, model: cfg.ai.model } : { error: r.error || 'Output verworpen door validatie', rejected: r.rejected, latencyMs: r.latencyMs }, callsToday: (usage[day] || 0) + 1, limit: cfg.ai.maxCallsPerDay };
  });

  // ---------- signalen ----------
  route('GET', '/api/signals', (req, res, a, q) => {
    const lim = num(q.get('limit'), { min: 1, max: 500 }) || 100;
    const inst = q.get('instrument') ? instId(q.get('instrument')) : null;
    const rows = inst ? db.all('SELECT * FROM signals WHERE instrument = ? ORDER BY created_at DESC LIMIT ?', inst, lim) : db.all('SELECT * FROM signals ORDER BY created_at DESC LIMIT ?', lim);
    return rows.map(r => ({ ...r, snapshot: undefined, plan: JSON.parse(r.snapshot).plan, conditions: JSON.parse(r.snapshot).conditions }));
  });
  route('GET', '/api/signals/:id', (req, res, a, q, p) => {
    const s = db.get('SELECT * FROM signals WHERE id = ?', str(p.id, 40));
    if (!s) throw new HttpError(404, 'Signaal niet gevonden');
    const d = JSON.parse(s.snapshot);
    return { ...s, snapshot: d, explanation: templateExplanation(d, getInstrument(s.instrument)), events: db.all('SELECT * FROM signal_events WHERE signal_id = ? ORDER BY at', s.id), deliveries: db.all('SELECT id, kind, status, attempts, last_error, created_at, sent_at, updated_at FROM outbox WHERE signal_id = ?', s.id), scenarios: db.all('SELECT * FROM scenarios WHERE signal_id = ? ORDER BY created_at DESC', s.id).map(x => JSON.parse(x.json)), paper: db.all('SELECT * FROM paper_positions WHERE signal_id = ?', s.id), orders: db.all('SELECT * FROM paper_orders WHERE signal_id = ?', s.id) };
  });
  route('POST', '/api/signals/:id/scenario', async (req, res, a, q, p) => {
    const s = db.get('SELECT * FROM signals WHERE id = ?', str(p.id, 40));
    if (!s) throw new HttpError(404, 'Signaal niet gevonden');
    const b = await readJson(req, 2000);
    const inst = getInstrument(s.instrument); const cfg = loadConfig(db);
    const plan = buildPlan({ inst, direction: s.direction, entry: num(b.entry) ?? s.entry_ref, sl: num(b.sl) ?? s.sl, tp1: num(b.tp1) ?? s.tp1, tp2: num(b.tp2) ?? s.tp2, costs: cfg.costs, accountCcy: cfg.risk.accountCcy, rates: engine?.currentRates() || {} });
    const sc = { id: `sc_${randomUUID().slice(0, 10)}`, signalId: s.id, createdAt: Date.now(), kind: 'MANUAL', note: 'Handmatig scenario; de originele signaalniveaus blijven ongewijzigd.', plan };
    db.run('INSERT INTO scenarios (id, signal_id, created_at, json) VALUES (?,?,?,?)', sc.id, s.id, sc.createdAt, JSON.stringify(sc));
    return sc;
  });

  // ---------- risico ----------
  route('POST', '/api/risk/calc', async (req) => {
    const b = await readJson(req, 4000);
    const inst = getInstrument(instId(b.instrument));
    const cfg = loadConfig(db);
    const dir = str(b.direction, 5, /^(LONG|SHORT)$/);
    const plan = buildPlan({ inst, direction: dir, entry: num(b.entry, { nullable: false }), sl: num(b.sl, { nullable: false }), tp1: num(b.tp1), tp2: num(b.tp2), costs: cfg.costs, accountCcy: str(b.accountCcy || cfg.risk.accountCcy, 3, /^[A-Z]{3}$/), rates: engine?.currentRates() || {} });
    const size = positionSize({ inst, plan, balance: num(b.balance, { min: 0 }), riskPct: num(b.riskPct, { min: 0, max: 100 }), riskMoney: num(b.riskMoney, { min: 0 }), accountCcy: plan.money.accountCcy, rates: engine?.currentRates() || {}, costs: cfg.costs, costBufferPct: num(b.costBufferPct, { min: 0, max: 50 }) || 0 });
    return { plan, size, display: { entry: fmtPrice(inst, plan.entry), sl: fmtPrice(inst, plan.sl), tp1: fmtPrice(inst, plan.tp1), tp2: fmtPrice(inst, plan.tp2) } };
  });

  // ---------- kalender ----------
  route('GET', '/api/calendar', () => {
    const cal = loadCalendar(db, Date.now());
    return { calendar: cal ? { ...cal, events: cal.events.map(e => ({ ...e, categoryLabel: CATEGORY_LABEL[e.category], interpretation: interpretation(e) })) } : null, coverageText: CALENDAR_COVERAGE_TEXT, official: OFFICIAL_SOURCES, policy: loadConfig(db).newsPolicy };
  });
  route('POST', '/api/calendar/refresh', async () => refreshCalendar(db, { fetchImpl }));
  route('POST', '/api/calendar/import', async (req) => {
    const buf = await readBody(req, 5_000_000);
    const { header, rows } = parseCsv(buf.toString('utf8'));
    const ix = k => header.findIndex(h => h.toLowerCase() === k);
    const [it, ic, iti, iim] = ['time', 'currency', 'title', 'impact'].map(ix);
    if ([it, ic, iti, iim].some(x => x < 0)) throw new HttpError(400, 'Kolommen vereist: time,currency,title,impact (optioneel: forecast,previous,actual,source_url)');
    let n = 0; let min = Infinity; let max = -Infinity;
    const { classify } = await import('../core/news.js');
    db.tx(() => {
      for (const r of rows) {
        const t = Date.parse(r[it]); if (!Number.isFinite(t)) continue;
        const id = createHash('sha1').update(`imp|${r[ic]}|${r[iti]}|${r[it]}`).digest('hex').slice(0, 20);
        db.run('INSERT OR REPLACE INTO calendar_events (id, source, title, currency, impact, category, time, all_day, forecast, previous, actual, url, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', id, 'import', r[iti].slice(0, 200), r[ic].slice(0, 8), r[iim], classify(r[iti]), t, 0, r[ix('forecast')] || null, r[ix('previous')] || null, r[ix('actual')] || null, r[ix('source_url')] || null, Date.now());
        n += 1; min = Math.min(min, t); max = Math.max(max, t);
      }
    });
    if (!n) throw new HttpError(400, 'Geen geldige events');
    setState(db, 'calendar.importMeta', { rows: n, from: min, to: max, at: Date.now() });
    db.run("INSERT INTO settings (key, value, updated_at) VALUES ('calendar.importCoverage', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", JSON.stringify({ from: min, to: max, source: 'import' }), Date.now());
    return { ok: true, imported: n, coverage: { from: min, to: max }, note: 'Dekking = eerste tot laatste event in het bestand. Controleer of het bestand alle relevante high-impact events bevat.' };
  });

  // ---------- instellingen + secrets ----------
  route('GET', '/api/settings', () => publicConfig());
  route('POST', '/api/settings', async (req) => {
    const patch = await readJson(req, 30_000);
    const r = saveConfig(db, patch);
    if (!r.ok) throw new HttpError(400, r.errors.join('; '));
    engine?.reloadConfig();
    const restart = patch.provider || patch.watchlist;
    if (restart) await engine?.restart();
    return { ok: true, configVersion: r.version, restarted: !!restart, config: publicConfig() };
  });
  route('POST', '/api/secrets', async (req) => {
    const { name, value } = await readJson(req, 5000);
    if (!SECRET_NAMES.includes(name)) throw new HttpError(400, 'Onbekend secret');
    const changed = secrets.set(name, typeof value === 'string' ? value.trim() : '');
    let link = null;
    if (changed && name === 'oanda.token') {
      link = await autoLinkOanda();
      await engine?.restart();
    }
    return { ok: true, changed, link, note: changed ? 'Opgeslagen (versleuteld).' : 'Leeg veld: bestaande waarde ongewijzigd.', status: publicConfig().secrets };
  });
  /** Na het plakken van een token: practice of live bepalen, account-ID ophalen, provider inschakelen. */
  async function autoLinkOanda() {
    const token = secrets.get('oanda.token');
    const cfg = loadConfig(db);
    for (const envName of [cfg.provider.env, cfg.provider.env === 'practice' ? 'live' : 'practice']) {
      try {
        const prov = createOandaProvider({ token, accountId: cfg.provider.accountId || 'x', env: envName, fetchImpl });
        const r = await prov.testConnection().catch(e => ({ ok: false, code: e.code, text: e.message }));
        if (r.code === 'UNAUTHORIZED') continue;
        // account-ID automatisch: eerste account dat het token kan zien
        let accountId = cfg.provider.accountId;
        if (!r.accountFound) {
          const res = await fetchImpl(`${envName === 'live' ? 'https://api-fxtrade.oanda.com' : 'https://api-fxpractice.oanda.com'}/v3/accounts`, { headers: { authorization: `Bearer ${token}` } });
          const j = await res.json().catch(() => ({}));
          accountId = j.accounts?.[0]?.id || null;
        }
        if (!accountId) return { ok: false, text: 'Token geldig, maar geen account gevonden.' };
        saveConfig(db, { provider: { name: 'oanda', env: envName, accountId } });
        engine?.reloadConfig();
        return { ok: true, env: envName, accountId, text: `Gekoppeld met OANDA ${envName === 'live' ? 'live' : 'practice'} (account ${accountId}).` };
      } catch (e) { return { ok: false, text: redact(e.message, [token]) }; }
    }
    return { ok: false, text: 'OANDA weigert dit token (practice én live geprobeerd).' };
  }

  route('POST', '/api/secrets/delete', async (req) => {
    const { name, confirm } = await readJson(req, 1000);
    if (!SECRET_NAMES.includes(name) || confirm !== true) throw new HttpError(400, 'Bevestiging vereist');
    secrets.remove(name);
    return { ok: true, status: publicConfig().secrets };
  });
  route('POST', '/api/connections/oanda/test', async () => {
    const cfg = loadConfig(db); const token = secrets.get('oanda.token');
    if (!token) return { ok: false, code: 'TOKEN_MISSING', text: 'OANDA-token ontbreekt.' };
    try {
      const r = await createOandaProvider({ token, accountId: cfg.provider.accountId, env: cfg.provider.env, fetchImpl }).testConnection();
      setState(db, 'oanda.check', { ...r, at: Date.now() });
      return { ...r, note: 'Alleen leesrequests; er is geen order geplaatst.' };
    } catch (e) {
      const out = { ok: false, code: e.code || 'ERROR', text: redact(e.message, [token]), at: Date.now() };
      setState(db, 'oanda.check', out); return out;
    }
  });
  route('POST', '/api/connections/telegram/test', async () => {
    const cfg = loadConfig(db); const token = secrets.get('telegram.token');
    const r = await checkTelegram(token, cfg.notifications.chatId, { fetchImpl });
    setState(db, 'telegram.check', { ...r, at: Date.now() });
    return r;
  });
  route('POST', '/api/telegram/test-message', async () => {
    const cfg = loadConfig(db);
    const r = enqueue(db, { kind: 'TEST', dedupeKey: `TEST:${Date.now()}`, payload: { text: `<b>TEST</b> — ForexNexus Alpha testmelding (${new Date().toISOString()}). Dit is geen signaal.` } });
    return { ...r, note: cfg.notifications.chatId ? 'TEST-melding in de outbox geplaatst.' : 'Chat-ID ontbreekt; de melding zal FAILED worden.' };
  });

  // ---------- engine ----------
  route('POST', '/api/engine/restart', async () => { await engine?.restart(); return { ok: true }; });
  route('POST', '/api/engine/scan-now', async () => { const { floorTf } = await import('../core/time.js'); await engine?.scanAll(floorTf(Date.now(), 'M5')); return { ok: true, status: engineStatus(db, engine) }; });
  route('GET', '/api/heartbeats', (req, res, a, q) => db.all('SELECT * FROM heartbeats WHERE kind = ? ORDER BY at DESC LIMIT 100', str(q.get('kind') || 'scan', 20, /^[a-z_]+$/)).map(h => ({ ...h, detail: h.detail ? JSON.parse(h.detail) : null })));
  route('GET', '/api/quality', () => db.all('SELECT * FROM data_quality ORDER BY at DESC LIMIT 200').map(r => ({ ...r, detail: JSON.parse(r.detail || 'null') })));

  // ---------- datasets + backtests ----------
  route('GET', '/api/datasets', () => listDatasets(db));
  route('GET', '/api/datasets/:id', (req, res, a, q, p) => { const r = db.get('SELECT * FROM datasets WHERE id = ?', decodeURIComponent(p.id)); if (!r) throw new HttpError(404, 'Niet gevonden'); return { ...r, quality: JSON.parse(r.quality || 'null'), corrections: JSON.parse(r.corrections || '[]') }; });
  route('POST', '/api/datasets/import', async (req, res, a, q) => {
    const buf = await readBody(req, 60_000_000);
    return importDataset(db, { buffer: buf, filename: str(q.get('filename') || 'upload.csv', 120, /^[\w.\- ]+$/), instrument: instId(q.get('instrument')), timeframe: str(q.get('timeframe') || 'M5', 4, /^(M1|M5|M15|H1|H4)$/), volumeType: str(q.get('volumeType') || 'none', 20, /^(none|tick_count|exchange|proxy)$/), tzOffsetMinutes: num(q.get('tzOffsetMinutes'), { min: -840, max: 840 }) || 0, kind: 'real', contract: q.get('contract') ? str(q.get('contract'), 12, /^[A-Z0-9]+$/) : null, source: 'csv' });
  });
  route('POST', '/api/datasets/synthetic', async (req) => { const b = await readJson(req, 500); return { datasetId: ensureSyntheticDataset(db, instId(b.instrument || 'EUR_USD'), num(b.months, { min: 1, max: 24 }) || 6) }; });
  route('POST', '/api/datasets/oanda', async (req) => {
    const b = await readJson(req, 1000);
    const cfg = loadConfig(db); const token = secrets.get('oanda.token');
    if (!token) throw new HttpError(400, 'OANDA-token ontbreekt');
    const id = instId(b.instrument); const tf = str(b.timeframe || 'M5', 4, /^(M1|M5|M15|H1|H4)$/);
    const from = num(b.from, { min: Date.UTC(2005, 0, 1), nullable: false }); const to = num(b.to, { max: Date.now() + 86_400_000, nullable: false });
    if (to <= from) throw new HttpError(400, 'Periode ongeldig');
    const jobId = `imp_${randomUUID().slice(0, 10)}`;
    const job = { id: jobId, status: 'RUNNING', progress: [] };
    importJobs.set(jobId, job);
    const prov = createOandaProvider({ token, accountId: cfg.provider.accountId, env: cfg.provider.env, fetchImpl });
    prov.fetchRange(INSTRUMENTS[id].providers.oanda, tf, from, to, pr => { job.progress = pr; })
      .then(c => { const r = registerProviderDataset(db, { instrument: id, timeframe: tf, provider: 'oanda', candles: c, env: cfg.provider.env }); Object.assign(job, { status: 'DONE', ...r }); })
      .catch(e => Object.assign(job, { status: 'FAILED', error: redact(e.message, [token]) }));
    return job;
  });
  route('GET', '/api/jobs/:id', (req, res, a, q, p) => getJob(p.id) || importJobs.get(p.id) || (() => { throw new HttpError(404, 'Onbekende job'); })());
  route('GET', '/api/backtests', () => listBacktests(db));
  route('POST', '/api/backtests', async (req) => {
    const b = await readJson(req, 2000);
    try { return startBacktest(db, { datasetId: str(b.datasetId, 200), strategyId: stratId(b.strategy), newsMode: b.newsMode === 'calendar' ? 'calendar' : 'off', riskPerTrade: num(b.riskPerTrade, { min: 0, max: 1e9 }) }); }
    catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, e.message); }
  });
  route('GET', '/api/backtests/:id', (req, res, a, q, p) => { const bt = getBacktest(db, str(p.id, 40)); if (!bt) throw new HttpError(404, 'Niet gevonden'); return { ...bt, trades: bt.trades.slice(0, 2000), skipped: bt.skipped.slice(0, 2000), tradeCount: bt.trades.length }; });
  route('GET', '/api/backtests/:id/trades.csv', (req, res, a, q, p) => { const bt = getBacktest(db, str(p.id, 40)); if (!bt) throw new HttpError(404, 'Niet gevonden'); send(res, 200, tradesCsv(bt), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${bt.id}-trades.csv"` }); return undefined; });
  route('GET', '/api/backtests/:id/report.html', (req, res, a, q, p) => { const bt = getBacktest(db, str(p.id, 40)); if (!bt?.metrics) throw new HttpError(404, 'Niet gevonden'); send(res, 200, reportHtml(bt), { 'content-type': 'text/html; charset=utf-8', 'content-disposition': `attachment; filename="${bt.id}-rapport.html"` }); return undefined; });
  route('GET', '/api/backtests/:id/report.json', (req, res, a, q, p) => { const bt = getBacktest(db, str(p.id, 40)); if (!bt) throw new HttpError(404, 'Niet gevonden'); send(res, 200, JSON.stringify(bt, null, 1), { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${bt.id}.json"` }); return undefined; });
  route('GET', '/api/matrix', () => testMatrix(db));
  route('GET', '/api/replay', (req, res, a, q) => replayStep(db, { datasetId: str(q.get('datasetId'), 200), strategyId: stratId(q.get('strategy')), cursor: num(q.get('cursor'), { min: 0, max: 5e6 }), window: num(q.get('window'), { min: 50, max: 1500 }) || 300 }));

  // ---------- paper ----------
  route('POST', '/api/paper/order', async (req) => {
    const b = await readJson(req, 1000);
    if (!engine) throw new HttpError(503, 'Engine niet actief');
    return engine.openManualPaper({ instrument: instId(b.instrument), direction: str(b.direction, 5, /^(LONG|SHORT)$/), units: num(b.units, { min: 1, max: 1e9 }), sl: num(b.sl, { min: 0 }), tp: num(b.tp, { min: 0 }) });
  });
  route('GET', '/api/paper', () => ({ summary: engine?.paperSummary() || null, positions: db.all('SELECT * FROM paper_positions ORDER BY opened_at DESC LIMIT 200'), orders: db.all('SELECT * FROM paper_orders ORDER BY requested_at DESC LIMIT 200'), notes: db.all('SELECT * FROM journal_notes ORDER BY at DESC LIMIT 200'), events: db.all('SELECT * FROM paper_events ORDER BY at DESC LIMIT 200') }));
  route('POST', '/api/paper/open', async (req) => { const b = await readJson(req, 1000); if (!engine) throw new HttpError(503, 'Engine niet actief'); return engine.openPaper(str(b.signalId, 40), 'MANUAL', num(b.units, { min: 1, max: 1e9 })); });
  route('POST', '/api/paper/:id/close', async (req, res, a, q, p) => {
    const pos = db.get("SELECT * FROM paper_positions WHERE id = ? AND status = 'OPEN'", str(p.id, 40));
    if (!pos) throw new HttpError(404, 'Geen open positie');
    const qte = engine?.hub.gatingQuote(pos.instrument, Date.now(), loadConfig(db).limits.maxQuoteAgeSec);
    if (!qte || qte.freshness === 'DISCONNECTED' || qte.freshness === 'STALE') throw new HttpError(409, 'Geen actuele quote om tegen te sluiten');
    return engine.closePaper(pos.id, pos.direction === 'LONG' ? qte.bid : qte.ask, 'Handmatig gesloten');
  });
  route('POST', '/api/paper/note', async (req) => {
    const b = await readJson(req, 3_000_000);
    const text = str(b.text, 5000); if (!text) throw new HttpError(400, 'Tekst vereist');
    let attachment = null;
    if (b.image) { if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.image) || b.image.length > 2_800_000) throw new HttpError(400, 'Afbeelding ongeldig of te groot (max ~2 MB)'); attachment = b.image; }
    db.run('INSERT INTO journal_notes (position_id, signal_id, at, text, attachment) VALUES (?,?,?,?,?)', b.positionId ? str(b.positionId, 40) : null, b.signalId ? str(b.signalId, 40) : null, Date.now(), text, attachment);
    return { ok: true };
  });

  // ---------- SSE ----------
  route('GET', '/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', ...securityHeaders() });
    res.write(`event: hello\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`);
    const c = { res, lastQuote: new Map() };
    sseClients.add(c);
    const ping = setInterval(() => res.write(`event: ping\ndata: ${Date.now()}\n\n`), 15_000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(c); });
    return undefined;
  });

  const importJobs = new Map();

  async function serveStatic(req, res, path) {
    let file;
    if (VENDOR[path]) file = VENDOR[path];
    else if (path.startsWith('/core/')) { file = normalize(join(CORE_DIR, path.slice(6))); if (!file.startsWith(CORE_DIR)) return false; }
    else { file = normalize(join(PUBLIC, path === '/' ? 'index.html' : path)); if (!file.startsWith(PUBLIC)) return false; }
    try {
      const st = await stat(file); if (!st.isFile()) return false;
      const body = await readFile(file);
      const isHtml = extname(file) === '.html';
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': isHtml || path === '/sw.js' ? 'no-cache' : 'public, max-age=300', ...securityHeaders() });
      res.end(body); return true;
    } catch { return false; }
  }

  async function handle(req, res) {
    let url;
    try { url = new URL(String(req.url || '/').replace(/^\/{2,}/, '/'), 'http://local'); }
    catch { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Ongeldig verzoek'); return; }
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(path); if (!m) continue;
          let a = null;
          if (!r.public) {
            a = auth(req);
            if (!a) throw new HttpError(401, 'Niet aangemeld', 'AUTH');
            if (req.method !== 'GET') requireCsrf(req, a);
          }
          const out = await r.handler(req, res, a, url.searchParams, m.groups || {});
          if (out !== undefined && !res.headersSent) send(res, 200, out);
          return;
        }
        throw new HttpError(404, 'Onbekend endpoint');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Methode niet toegestaan');
      if (await serveStatic(req, res, path)) return;
      if (!extname(path)) { if (await serveStatic(req, res, '/')) return; }
      throw new HttpError(404, 'Niet gevonden');
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) log.error?.('[http]', redact(e.stack || e.message, [secrets.get('oanda.token'), secrets.get('telegram.token'), secrets.get('gemini.key')]));
      if (!res.headersSent) send(res, status, { error: status >= 500 ? 'Interne fout' : e.message, code: e.code || null });
      else res.end();
    }
  }

  const server = createServer({ requestTimeout: 120_000, headersTimeout: 20_000 }, handle);
  return { server, handle, sseClients };
}
