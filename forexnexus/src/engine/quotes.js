// QuoteHub: houdt per instrument de laatst ontvangen quote bij, plus het
// moment van de laatste prijsverandering en de provider-heartbeat.
// Een ontbrekende quote krijgt NOOIT een nieuwe lokale timestamp.

export class QuoteHub {
  constructor() {
    this.quotes = new Map();
    this.heartbeatAt = null; // laatste HEARTBEAT of PRICE van de provider (providertijd)
    this.heartbeatReceivedAt = null;
    this.listeners = new Set();
    this.connected = false;
    this.mode = 'none'; // 'stream' | 'polling' | 'demo' | 'none'
    this.pollIntervalMs = null;
    this.lastError = null;
    this.latency = []; // ontvangsttijd - providertijd (ms), begrensd
  }

  update(q) {
    if (q.bid == null || q.ask == null || !Number.isFinite(q.time)) return;
    const prev = this.quotes.get(q.instrument);
    if (prev && q.time < prev.time) return; // oudere update na reconnect negeren
    const changed = !prev || prev.bid !== q.bid || prev.ask !== q.ask;
    const next = { ...q, lastChangeAt: changed ? q.time : prev.lastChangeAt };
    this.quotes.set(q.instrument, next);
    this.heartbeatAt = q.time; this.heartbeatReceivedAt = q.receivedAt;
    if (q.receivedAt && q.kind === 'real') {
      this.latency.push(q.receivedAt - q.time);
      if (this.latency.length > 500) this.latency.shift();
    }
    for (const fn of this.listeners) { try { fn(next); } catch { /* listener-fout negeren */ } }
  }

  heartbeat(providerTime, receivedAt) { this.heartbeatAt = providerTime; this.heartbeatReceivedAt = receivedAt; }

  get(instrument) { return this.quotes.get(instrument) || null; }

  latencyStats() {
    if (!this.latency.length) return null;
    const s = [...this.latency].sort((a, b) => a - b);
    const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { samples: s.length, p50: q(0.5), p95: q(0.95), max: s.at(-1), note: 'Ontvangsttijd minus providertijd; afhankelijk van klokgelijkheid.' };
  }

  /**
   * Actualiteit van een quote:
   *  LIVE        — recente prijsupdate
   *  UNCHANGED   — stream verbonden en provider-heartbeat recent, maar geen prijswijziging
   *                (een stream stuurt alleen wijzigingen; dit is geen verbroken verbinding)
   *  STALE       — geen recente update en geen recente heartbeat
   *  DISCONNECTED— verbinding verbroken
   * `confirmedAt` is het laatste PROVIDER-tijdstip waarop de prijs bevestigd is
   * (quote of heartbeat via een verbonden stream) — nooit een lokale klok.
   */
  freshness(instrument, now = Date.now(), maxAgeSec = 5) {
    const q = this.get(instrument);
    const hbAge = this.heartbeatReceivedAt ? (now - this.heartbeatReceivedAt) / 1000 : null;
    if (!q) return { state: this.connected ? 'NO_QUOTE' : 'DISCONNECTED', quoteAgeSec: null, heartbeatAgeSec: hbAge, confirmedAt: null };
    const age = (now - q.time) / 1000;
    if (!this.connected) return { state: 'DISCONNECTED', quoteAgeSec: age, heartbeatAgeSec: hbAge, confirmedAt: q.time };
    if (age <= maxAgeSec) return { state: 'LIVE', quoteAgeSec: age, heartbeatAgeSec: hbAge, confirmedAt: q.time };
    if (this.mode === 'stream' && hbAge != null && hbAge <= 10 && q.tradeable !== false) {
      return { state: 'UNCHANGED', quoteAgeSec: age, heartbeatAgeSec: hbAge, confirmedAt: Math.max(q.time, this.heartbeatAt || 0), note: 'Stream en heartbeat actief; prijs sinds de laatste update ongewijzigd' };
    }
    return { state: 'STALE', quoteAgeSec: age, heartbeatAgeSec: hbAge, confirmedAt: q.time };
  }

  /** Quote voor de evaluator: tijd = laatste providerbevestiging. */
  gatingQuote(instrument, now = Date.now(), maxAgeSec = 5) {
    const q = this.get(instrument);
    if (!q) return null;
    const f = this.freshness(instrument, now, maxAgeSec);
    return { ...q, time: f.confirmedAt ?? q.time, quoteTime: q.time, freshness: f.state };
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
}
