// Gebruikersconfiguratie met versiebeheer. Iedere gewijzigde configuratie
// krijgt een nieuwe config_version; signalen verwijzen naar de versie die gold.

import { createHash } from 'node:crypto';
import { DEFAULT_SESSIONS, DEFAULT_FX_HOLIDAYS } from '../core/sessions.js';
import { DEFAULT_NEWS_POLICY } from '../core/news.js';
import { DEFAULT_LIMITS } from '../core/evaluate.js';
import { DEFAULT_COSTS } from '../core/risk.js';
import { DEFAULT_WATCHLIST, INSTRUMENTS } from '../core/instruments.js';
import { STRATEGIES, DEFAULT_STRATEGY } from '../core/strategies/index.js';
import { getSetting, setSetting } from '../store/db.js';

export const DEFAULT_CONFIG = Object.freeze({
  provider: { name: 'demo', env: 'practice', accountId: '' },
  watchlist: [...DEFAULT_WATCHLIST],
  strategies: { enabled: ['EMA_RSI_WINDOW', 'LEGACY_EMA_RSI_VOL', 'STRUCT_SWEEP_MSS'], default: DEFAULT_STRATEGY },
  sessions: DEFAULT_SESSIONS,
  fxHolidays: DEFAULT_FX_HOLIDAYS,
  newsPolicy: DEFAULT_NEWS_POLICY,
  limits: DEFAULT_LIMITS,
  costs: DEFAULT_COSTS,
  risk: { accountCcy: 'EUR', balance: null, riskPct: null, riskMoney: null, costBufferPct: 0, maxPositions: 2, dailyLossLimitR: null },
  notifications: { telegramEnabled: false, chatId: '', entry: true, cancelled: true, expired: false, paperExit: true, cooldownMin: 30 },
  // Papersaldo is een expliciet gekozen, instelbaar oefenbedrag — geen echt accountsaldo.
  paper: { autoStrategy: 'EMA_RSI_WINDOW', balance: 10000, currency: 'EUR', riskPct: 1 },
  display: { tz: 'Europe/Brussels' },
  ai: { provider: 'none', model: 'gemini-3.5-flash-lite', maxCallsPerDay: 50 },
  scheduler: { evalDelaySec: 5, candleRetrySec: 10, candleRetries: 3 },
  appUrl: '',
});

function deepMerge(a, b) {
  if (Array.isArray(b)) return [...b];
  if (b && typeof b === 'object') {
    const out = { ...(a && typeof a === 'object' && !Array.isArray(a) ? a : {}) };
    for (const [k, v] of Object.entries(b)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return b === undefined ? a : b;
}

export function loadConfig(db) {
  return deepMerge(structuredClone(DEFAULT_CONFIG), getSetting(db, 'config', {}));
}

const isNum = (x, min = -Infinity, max = Infinity) => x === null || (typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max);

/** Strikte validatie; onbekende sleutels worden geweigerd. */
export function validateConfigPatch(patch) {
  const errors = [];
  const allowedTop = Object.keys(DEFAULT_CONFIG);
  for (const k of Object.keys(patch || {})) if (!allowedTop.includes(k)) errors.push(`Onbekende instelling: ${k}`);
  const p = patch || {};
  if (p.provider) {
    if (p.provider.name && !['demo', 'oanda'].includes(p.provider.name)) errors.push('provider.name moet demo of oanda zijn');
    if (p.provider.env && !['practice', 'live'].includes(p.provider.env)) errors.push('provider.env moet practice of live zijn');
    if (p.provider.accountId != null && !/^[0-9A-Za-z-]{0,40}$/.test(p.provider.accountId)) errors.push('Ongeldig account-ID');
  }
  if (p.watchlist) {
    if (!Array.isArray(p.watchlist) || p.watchlist.length > 10) errors.push('watchlist ongeldig');
    else for (const w of p.watchlist) if (!INSTRUMENTS[w]) errors.push(`Onbekend instrument ${w}`);
  }
  if (p.strategies?.enabled) for (const s of p.strategies.enabled) if (!STRATEGIES[s]) errors.push(`Onbekende strategie ${s}`);
  if (p.strategies?.default && !STRATEGIES[p.strategies.default]) errors.push('Onbekende standaardstrategie');
  if (p.limits) for (const [k, v] of Object.entries(p.limits)) if (!(k in DEFAULT_LIMITS) || !isNum(v, 0, 100000)) errors.push(`limits.${k} ongeldig`);
  if (p.risk) {
    for (const k of ['balance', 'riskPct', 'riskMoney', 'costBufferPct', 'maxPositions', 'dailyLossLimitR']) if (k in p.risk && !isNum(p.risk[k], 0, 1e12)) errors.push(`risk.${k} ongeldig`);
    if (p.risk.riskPct != null && p.risk.riskPct > 100) errors.push('risk.riskPct > 100');
    if (p.risk.accountCcy && !/^[A-Z]{3}$/.test(p.risk.accountCcy)) errors.push('risk.accountCcy ongeldig');
  }
  if (p.notifications?.chatId != null && !/^-?[0-9]{1,20}$|^@[A-Za-z0-9_]{4,64}$|^$/.test(String(p.notifications.chatId))) errors.push('Ongeldige Telegram chat-ID');
  if (p.sessions) for (const [k, w] of Object.entries(p.sessions)) {
    if (!/^\d{1,2}:\d{2}$/.test(w.start || '') || !/^\d{1,2}:\d{2}$/.test(w.end || '')) errors.push(`sessions.${k} tijden ongeldig`);
    try { new Intl.DateTimeFormat('en', { timeZone: w.tz }); } catch { errors.push(`sessions.${k}.tz ongeldig`); }
  }
  if (p.newsPolicy) for (const k of ['highImpact', 'rateDecision']) if (p.newsPolicy[k] && (!isNum(p.newsPolicy[k].before, 0, 600) || !isNum(p.newsPolicy[k].after, 0, 600))) errors.push(`newsPolicy.${k} ongeldig`);
  if (p.costs) {
    if (p.costs.spreadMode && !['bidask', 'model'].includes(p.costs.spreadMode)) errors.push('costs.spreadMode ongeldig');
    for (const k of ['slippagePerSide', 'commissionPerSidePerUnit', 'commissionPerSidePerContract']) if (k in p.costs && !isNum(p.costs[k], 0, 1000)) errors.push(`costs.${k} ongeldig`);
  }
  if (p.display?.tz) { try { new Intl.DateTimeFormat('en', { timeZone: p.display.tz }); } catch { errors.push('display.tz ongeldig'); } }
  if (p.ai?.provider && !['none', 'gemini'].includes(p.ai.provider)) errors.push('ai.provider ongeldig');
  if (p.appUrl != null && p.appUrl !== '' && !/^https:\/\/[^\s"<>]{3,200}$/.test(p.appUrl)) errors.push('appUrl moet met https:// beginnen');
  if (p.paper?.autoStrategy != null && !STRATEGIES[p.paper.autoStrategy]) errors.push('paper.autoStrategy ongeldig');
  if (p.paper) { if ('balance' in p.paper && !isNum(p.paper.balance, 1, 1e9)) errors.push('paper.balance ongeldig'); if ('riskPct' in p.paper && !isNum(p.paper.riskPct, 0.01, 10)) errors.push('paper.riskPct ongeldig'); if (p.paper.currency && !/^[A-Z]{3}$/.test(p.paper.currency)) errors.push('paper.currency ongeldig'); }
  if (JSON.stringify(p).length > 20000) errors.push('Configuratie te groot');
  return errors;
}

export function saveConfig(db, patch) {
  const errors = validateConfigPatch(patch);
  if (errors.length) return { ok: false, errors };
  const merged = deepMerge(loadConfig(db), patch);
  setSetting(db, 'config', merged);
  const version = configVersion(db, merged);
  return { ok: true, config: merged, version };
}

export function configVersion(db, cfg) {
  const json = JSON.stringify(cfg);
  const hash = createHash('sha256').update(json).digest('hex');
  const r = db.get('SELECT id FROM config_versions WHERE hash = ?', hash);
  if (r) return r.id;
  return Number(db.run('INSERT INTO config_versions (hash, json, created_at) VALUES (?,?,?)', hash, json, Date.now()).lastInsertRowid);
}
