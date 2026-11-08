// API-client met CSRF-token en SSE. Niet-gevoelige laatste waarden worden
// lokaal bewaard met hun ORIGINELE timestamp voor een eerlijke offlineweergave.

let csrf = null;
export function setCsrf(v) { csrf = v; }

export class ApiError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }

export async function api(path, { method = 'GET', body, raw = false, headers = {} } = {}) {
  const opts = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (method !== 'GET') opts.headers['x-csrf-token'] = csrf || '';
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) opts.body = body;
    else { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  }
  let res;
  try { res = await fetch(path, opts); } catch (e) { throw new ApiError(0, 'Server niet bereikbaar (offline?)', 'OFFLINE'); }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`, data.code);
  return data;
}

const CACHE_KEYS = ['overview', 'status'];
export function cachePut(key, data) {
  if (!CACHE_KEYS.includes(key)) return;
  try { localStorage.setItem(`fnx:${key}`, JSON.stringify({ savedAt: Date.now(), data })); } catch { /* opslag niet beschikbaar */ }
}
export function cacheGet(key) {
  try { const v = localStorage.getItem(`fnx:${key}`); return v ? JSON.parse(v) : null; } catch { return null; }
}

export function connectStream(handlers) {
  let es = null; let closed = false; let retry = 1000;
  const open = () => {
    if (closed) return;
    es = new EventSource('/api/stream');
    es.addEventListener('hello', () => { retry = 1000; handlers.onOpen?.(); });
    for (const t of ['quote', 'status', 'signal', 'scan', 'evaluation', 'paper']) es.addEventListener(t, e => { try { handlers[t]?.(JSON.parse(e.data)); } catch { /* */ } });
    es.onerror = () => { handlers.onError?.(); es.close(); setTimeout(open, retry); retry = Math.min(30_000, retry * 2); };
  };
  open();
  return () => { closed = true; es?.close(); };
}

// ---------- weergave ----------
let tz = 'Europe/Brussels';
export function setTz(v) { tz = v || 'Europe/Brussels'; }
export function getTz() { return tz; }
const fmts = new Map();
function f(key, opts) { let x = fmts.get(key); if (!x) { x = new Intl.DateTimeFormat('nl-BE', opts); fmts.set(key, x); } return x; }
export function fmtTime(ms, { seconds = false, date = true, zone = tz } = {}) {
  if (ms == null) return '—';
  return f(`${zone}${seconds}${date}`, { timeZone: zone, hourCycle: 'h23', ...(date ? { day: '2-digit', month: '2-digit' } : {}), hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) }).format(new Date(ms));
}
export function fmtUtc(ms) { return ms == null ? '—' : new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC'; }
export function ago(ms, now = Date.now()) {
  if (ms == null) return '—';
  const s = Math.round((now - ms) / 1000);
  if (s < 0) return `over ${fmtDur(-s)}`;
  return `${fmtDur(s)} geleden`;
}
export function fmtDur(s) {
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${(s / 3600).toFixed(1).replace('.', ',')} u`;
  return `${(s / 86400).toFixed(1).replace('.', ',')} d`;
}
export function nf(x, d = 2) { return x == null || !Number.isFinite(x) ? '—' : x.toLocaleString('nl-BE', { minimumFractionDigits: d, maximumFractionDigits: d }); }
export function px(inst, p) { return p == null || !Number.isFinite(p) ? '—' : p.toFixed(inst?.precision ?? 5); }

export const STATE_UI = {
  BUY: { sym: '▲', text: 'BUY', long: 'BUY — mogelijke longentry' },
  SELL: { sym: '▼', text: 'SELL', long: 'SELL — mogelijke shortentry' },
  WAIT: { sym: '⏸', text: 'WAIT', long: 'WAIT — voorbereiding, nog niet bevestigd' },
  NO_TRADE: { sym: '⛔', text: 'NO TRADE', long: 'NO TRADE — entry geblokkeerd' },
  NONE: { sym: '○', text: 'GEEN SETUP', long: 'Geen setup volgens de regels' },
};
export const SIGNAL_STATUS = {
  ACTIVE: 'Actief', EXPIRED: 'EXPIRED — entryvenster verlopen', CANCELLED: 'CANCELLED — ingetrokken', ENTRY_MISSED: 'ENTRY GEMIST', TAKEN: 'Paperpositie geopend',
};
export const FRESH_UI = {
  LIVE: { cls: 'ok', text: 'LIVE' }, UNCHANGED: { cls: 'ok', text: 'LIVE (ongewijzigd)' }, STALE: { cls: 'warn', text: 'STALE' },
  DISCONNECTED: { cls: 'err', text: 'VERBROKEN' }, NO_QUOTE: { cls: 'warn', text: 'GEEN QUOTE' }, MARKET_CLOSED: { cls: '', text: 'MARKT GESLOTEN' },
};
