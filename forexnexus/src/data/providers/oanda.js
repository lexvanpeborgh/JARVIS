// OANDA v20 — Forex-provider (alleen lezen; deze module plaatst NOOIT orders).
// Endpoints volgens https://developer.oanda.com/rest-live-v20/ :
//   GET /v3/accounts                                   (tokencontrole)
//   GET /v3/accounts/{id}/summary                      (accountcontrole, read-only)
//   GET /v3/instruments/{instrument}/candles           (historische candles, price=BA)
//   GET /v3/accounts/{id}/pricing                      (momentopname quotes)
//   GET stream: /v3/accounts/{id}/pricing/stream       (PRICE + HEARTBEAT, newline-JSON)
// Het candleveld `volume` telt prijsupdates binnen de candle (tickvolume),
// niet het verhandelde volume van de wereldwijde Forex-markt.

import { TF_MS } from '../../core/time.js';

export const OANDA_HOSTS = Object.freeze({
  practice: { rest: 'https://api-fxpractice.oanda.com', stream: 'https://stream-fxpractice.oanda.com' },
  live: { rest: 'https://api-fxtrade.oanda.com', stream: 'https://stream-fxtrade.oanda.com' },
});

const GRAN = { M1: 'M1', M5: 'M5', M15: 'M15', H1: 'H1', H4: 'H4' };

export class ProviderError extends Error {
  constructor(message, { status = null, code = null, retryAfter = null } = {}) { super(message); this.status = status; this.code = code; this.retryAfter = retryAfter; }
}

function num(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }

export function parseCandle(raw, instrument) {
  const t = Date.parse(raw.time);
  const b = raw.bid ? { o: num(raw.bid.o), h: num(raw.bid.h), l: num(raw.bid.l), c: num(raw.bid.c) } : null;
  const a = raw.ask ? { o: num(raw.ask.o), h: num(raw.ask.h), l: num(raw.ask.l), c: num(raw.ask.c) } : null;
  let mid;
  if (raw.mid) mid = { o: num(raw.mid.o), h: num(raw.mid.h), l: num(raw.mid.l), c: num(raw.mid.c) };
  else if (b && a) mid = { o: (b.o + a.o) / 2, h: (b.h + a.h) / 2, l: (b.l + a.l) / 2, c: (b.c + a.c) / 2 };
  // NB: mid-high = gemiddelde van bid-high en ask-high (benadering wanneer alleen BA wordt opgevraagd)
  const c = { t, ...mid, v: num(raw.volume), vType: 'tick_count', complete: raw.complete === true, src: 'oanda', kind: 'real', priceType: b && a ? 'BA' : 'M', instrument };
  if (b && a) { c.b = b; c.a = a; }
  return c;
}

export function parsePrice(msg, receivedAt) {
  if (msg.type === 'HEARTBEAT') return { type: 'HEARTBEAT', time: Date.parse(msg.time), receivedAt };
  if (msg.type !== 'PRICE') return null;
  const bid = num(msg.bids?.[0]?.price); const ask = num(msg.asks?.[0]?.price);
  return { type: 'PRICE', instrument: msg.instrument, bid, ask, time: Date.parse(msg.time), receivedAt, tradeable: msg.tradeable !== false, source: 'oanda', kind: 'real' };
}

export function createOandaProvider({ token, accountId, env = 'practice', fetchImpl = fetch, timeoutMs = 10_000 }) {
  const hosts = OANDA_HOSTS[env] || OANDA_HOSTS.practice;
  const headers = { authorization: `Bearer ${token}`, 'accept-datetime-format': 'RFC3339', 'content-type': 'application/json' };
  let lastRateLimit = null;

  async function get(path, { stream = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
    let res;
    try { res = await fetchImpl(`${stream ? hosts.stream : hosts.rest}${path}`, { method: 'GET', headers, signal: ctrl.signal }); }
    catch (e) { throw new ProviderError(`OANDA niet bereikbaar: ${e.message}`, { code: 'NETWORK' }); }
    finally { clearTimeout(timer); }
    if (res.status === 429) {
      lastRateLimit = Date.now();
      throw new ProviderError('OANDA rate limit (429)', { status: 429, code: 'RATE_LIMIT', retryAfter: num(res.headers.get('retry-after')) });
    }
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch { /* geen JSON */ }
    if (!res.ok) {
      const msg = data?.errorMessage || `HTTP ${res.status}`;
      throw new ProviderError(`OANDA: ${msg}`, { status: res.status, code: res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND' : 'HTTP' });
    }
    return data;
  }

  return {
    id: 'oanda',
    kind: 'real',
    env,
    label: `OANDA v20 (${env === 'live' ? 'live' : 'practice'})`,
    get lastRateLimit() { return lastRateLimit; },

    /** Verbindingstest: alleen GET-requests. Plaatst nooit een order. */
    async testConnection() {
      const accounts = await get('/v3/accounts');
      const ids = (accounts.accounts || []).map(a => a.id);
      const result = { ok: true, accountsVisible: ids.length, accountFound: ids.includes(accountId) };
      if (!accountId) return { ...result, ok: false, code: 'ACCOUNT_ID_MISSING' };
      if (!result.accountFound) return { ...result, ok: false, code: 'ACCOUNT_NOT_FOUND' };
      const summary = await get(`/v3/accounts/${encodeURIComponent(accountId)}/summary`);
      result.currency = summary.account?.currency || null;
      const p = await get(`/v3/accounts/${encodeURIComponent(accountId)}/pricing?instruments=EUR_USD`);
      const pr = p.prices?.[0];
      result.samplePrice = pr ? { instrument: pr.instrument, bid: num(pr.bids?.[0]?.price), ask: num(pr.asks?.[0]?.price), time: pr.time, tradeable: pr.tradeable } : null;
      return result;
    },

    async fetchCandles(instrument, tf, { count = 500, from = null, to = null } = {}) {
      const g = GRAN[tf]; if (!g) throw new ProviderError(`Tijdframe ${tf} niet ondersteund`);
      const q = new URLSearchParams({ price: 'BA', granularity: g });
      if (from != null) { q.set('from', new Date(from).toISOString()); if (to != null) q.set('to', new Date(to).toISOString()); else q.set('count', String(Math.min(count, 5000))); }
      else q.set('count', String(Math.min(count, 5000)));
      const data = await get(`/v3/instruments/${encodeURIComponent(instrument)}/candles?${q}`);
      return (data.candles || []).map(c => parseCandle(c, instrument));
    },

    /** Historische import in blokken van max. 5000 candles. */
    async fetchRange(instrument, tf, from, to, onChunk = () => {}) {
      const step = TF_MS[tf]; const out = [];
      let cur = from;
      while (cur < to) {
        const end = Math.min(to, cur + 4900 * step);
        const chunk = await this.fetchCandles(instrument, tf, { from: cur, to: end });
        out.push(...chunk);
        onChunk({ from: cur, to: end, received: chunk.length, total: out.length });
        cur = end;
      }
      return out;
    },

    async getQuotes(instruments) {
      const data = await get(`/v3/accounts/${encodeURIComponent(accountId)}/pricing?instruments=${instruments.map(encodeURIComponent).join(',')}`);
      const now = Date.now();
      return (data.prices || []).map(p => parsePrice({ ...p, type: 'PRICE' }, now));
    },

    /**
     * Streaming quotes. Roept onMessage aan voor PRICE en HEARTBEAT.
     * Resolvet wanneer de stream eindigt; gooit bij fouten. Reconnect gebeurt in de engine.
     */
    async stream(instruments, onMessage, signal) {
      const res = await fetchImpl(`${hosts.stream}/v3/accounts/${encodeURIComponent(accountId)}/pricing/stream?instruments=${instruments.map(encodeURIComponent).join(',')}`, { headers, signal });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new ProviderError(`Stream HTTP ${res.status}`, { status: res.status, code: res.status === 401 ? 'UNAUTHORIZED' : 'HTTP', detail: t.slice(0, 200) });
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          const p = parsePrice(msg, Date.now());
          if (p) onMessage(p);
        }
        if (buf.length > 1_000_000) buf = ''; // begrensde buffer
      }
    },
  };
}
