// Grafiek op basis van TradingView Lightweight Charts v5 (Apache-2.0; attributielogo blijft zichtbaar).
// Een grafiekbibliotheek is geen databron: alle data komt van de server.

import { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers, CrosshairMode, LineStyle, LineType } from 'lightweight-charts';
import { fmtTime, px } from './api.js';

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const sec = ms => Math.floor(ms / 1000);

export const DEFAULT_LAYERS = { ema: true, plan: true, blackouts: true, rsi: false, volume: false, sessions: false, levels: false, asian: false, structure: false };
export const LAYER_LABELS = { ema: 'EMA 9/21', plan: 'Entry/SL/TP', blackouts: 'Nieuwsblackouts', rsi: 'RSI14', volume: 'Volume', sessions: 'Sessies', levels: 'Vorige dag H/L', asian: 'Aziatische range', structure: 'Structuur (pivots, sweeps, MSS, FVG)' };

/** Zoek x-coördinaat voor een willekeurig tijdstip, ook tussen of voorbij candles. */
function xFor(chart, times, stepSec, tSec) {
  const ts = chart.timeScale();
  if (!times.length) return null;
  let lo = 0; let hi = times.length - 1;
  if (tSec >= times[hi]) {
    const x = ts.timeToCoordinate(times[hi]);
    return x == null ? null : x + ((tSec - times[hi]) / stepSec) * ts.options().barSpacing;
  }
  if (tSec <= times[0]) {
    const x = ts.timeToCoordinate(times[0]);
    return x == null ? null : x - ((times[0] - tSec) / stepSec) * ts.options().barSpacing;
  }
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (times[m] <= tSec) lo = m; else hi = m; }
  const x0 = ts.timeToCoordinate(times[lo]);
  return x0 == null ? null : x0 + ((tSec - times[lo]) / stepSec) * ts.options().barSpacing;
}

/** Primitive: verticale banden (sessies, nieuwsblackouts). */
class BandsPrimitive {
  constructor(getCtx) { this.getCtx = getCtx; this.bands = []; }
  attached(p) { this.p = p; }
  setBands(b) { this.bands = b; this.p?.requestUpdate(); }
  updateAllViews() {}
  paneViews() {
    const self = this;
    return [{
      zOrder: () => 'bottom',
      renderer: () => ({
        draw(target) {
          const { chart, times, step } = self.getCtx();
          target.useBitmapCoordinateSpace(({ context: c, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
            for (const b of self.bands) {
              const x1 = xFor(chart, times, step, sec(b.start)); const x2 = xFor(chart, times, step, sec(b.end));
              if (x1 == null || x2 == null || x2 < 0 || x1 > bitmapSize.width / hr) continue;
              c.fillStyle = b.color;
              c.fillRect(Math.round(x1 * hr), 0, Math.max(1, Math.round((x2 - x1) * hr)), bitmapSize.height);
              if (b.label) { c.fillStyle = b.textColor || 'rgba(140,155,176,.9)'; c.font = `${11 * vr}px system-ui`; c.fillText(b.label, Math.round((x1 + 4) * hr), bitmapSize.height - 8 * vr); }
            }
          });
        },
      }),
    }];
  }
}

/** Primitive: risico- en doelvakken met labels die elkaar niet overlappen. */
class PlanPrimitive {
  constructor(getCtx) { this.getCtx = getCtx; this.plan = null; }
  attached(p) { this.p = p; this.series = p.series; }
  setPlan(plan) { this.plan = plan; this.p?.requestUpdate(); }
  updateAllViews() {}
  paneViews() {
    const self = this;
    return [{
      zOrder: () => 'top',
      renderer: () => ({
        draw(target) {
          const pl = self.plan; if (!pl) return;
          const { chart, times, step, inst } = self.getCtx();
          const y = p => (p == null ? null : self.series.priceToCoordinate(p));
          target.useBitmapCoordinateSpace(({ context: c, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
            const W = bitmapSize.width / hr;
            const xs = xFor(chart, times, step, sec(pl.startTime)) ?? 0;
            const xe = Math.min(W - 4, Math.max(xs + 80, xFor(chart, times, step, sec(pl.endTime)) ?? W));
            const ye = y(pl.entry); const ys = y(pl.sl); const t1 = y(pl.tp1); const t2 = y(pl.tp2);
            if (ye == null) return;
            const rect = (a, b, col) => { if (b == null) return; c.fillStyle = col; c.fillRect(Math.round(xs * hr), Math.round(Math.min(a, b) * vr), Math.round((xe - xs) * hr), Math.round(Math.abs(b - a) * vr)); };
            rect(ye, ys, pl.manual ? 'rgba(229,83,75,.10)' : 'rgba(229,83,75,.18)');
            rect(ye, pl.exitTarget === 'tp1' ? t1 : t2, pl.manual ? 'rgba(63,182,139,.10)' : 'rgba(63,182,139,.16)');
            const line = (yy, col, dash) => { if (yy == null) return; c.strokeStyle = col; c.lineWidth = Math.max(1, hr * 1.5); c.setLineDash(dash ? [6 * hr, 4 * hr] : []); c.beginPath(); c.moveTo(xs * hr, yy * vr); c.lineTo(xe * hr, yy * vr); c.stroke(); };
            const buy = css('--buy'); const sell = css('--sell'); const acc = css('--accent');
            line(ye, acc, false); line(ys, sell, false); line(t1, buy, pl.tp1Role === 'observation'); line(t2, buy, pl.exitTarget !== 'tp2');
            // labels: rechts in het vak, verticaal uit elkaar geduwd (min. 18 px)
            const labels = [
              { y: ye, text: `ENTRY ${px(inst, pl.entry)}`, col: acc },
              { y: ys, text: `SL ${px(inst, pl.sl)} · ${pl.dist.sl.value} ${pl.dist.sl.unit}`, col: sell },
              pl.tp1 != null && { y: t1, text: `TP1 ${px(inst, pl.tp1)} · RR ${pl.rr.tp1.gross}${pl.tp1Role === 'observation' ? ' (obs.)' : ''}`, col: buy },
              pl.tp2 != null && { y: t2, text: `TP2 ${px(inst, pl.tp2)} · RR ${pl.rr.tp2.gross}${pl.exitTarget === 'tp2' ? '' : ' (obs.)'}`, col: buy },
            ].filter(l => l && l.y != null).sort((a, b) => a.y - b.y);
            const minGap = 18;
            for (let k = 1; k < labels.length; k += 1) if (labels[k].y - labels[k - 1].y < minGap) labels[k].y = labels[k - 1].y + minGap;
            c.font = `600 ${11 * vr}px system-ui`;
            for (const l of labels) {
              const w = c.measureText(l.text).width / hr + 10;
              const lx = Math.max(xs + 2, xe - w - 2);
              c.fillStyle = css('--panel');
              c.fillRect(lx * hr, (l.y - 8) * vr, w * hr, 16 * vr);
              c.fillStyle = l.col; c.fillText(l.text, (lx + 5) * hr, (l.y + 4) * vr);
            }
          });
        },
      }),
    }];
  }
}

export function createTradingChart(el, { inst, tf = 'M5' }) {
  const step = { M1: 60, M5: 300, M15: 900, H1: 3600, H4: 14400 }[tf] || 300;
  const chart = createChart(el, {
    autoSize: true,
    layout: { background: { color: css('--panel') }, textColor: css('--muted'), fontSize: 12, attributionLogo: true, panes: { separatorColor: css('--line') } },
    grid: { vertLines: { color: 'rgba(120,140,160,.08)' }, horzLines: { color: 'rgba(120,140,160,.08)' } },
    crosshair: { mode: CrosshairMode.Normal },
    rightPriceScale: { borderColor: css('--line') },
    timeScale: { borderColor: css('--line'), timeVisible: true, secondsVisible: false, rightOffset: 8,
      tickMarkFormatter: (t, type) => fmtTime(t * 1000, { date: type <= 2 }).replace(/^(\d\d\/\d\d) 00:00$/, '$1') },
    localization: { timeFormatter: t => fmtTime(t * 1000), priceFormatter: p => px(inst, p) },
    handleScale: true, handleScroll: true,
  });
  const ctx = { chart, times: [], step, inst };
  const candles = chart.addSeries(CandlestickSeries, { upColor: css('--buy'), downColor: css('--sell'), wickUpColor: css('--buy'), wickDownColor: css('--sell'), borderVisible: false, priceFormat: { type: 'price', precision: inst.precision, minMove: inst.tick } });
  const markers = createSeriesMarkers(candles, []);
  const bands = new BandsPrimitive(() => ctx); candles.attachPrimitive(bands);
  const planP = new PlanPrimitive(() => ctx); candles.attachPrimitive(planP);
  const s = { emaF: null, emaS: null, rsi: null, vol: null, pdh: null, pdl: null, ah: null, al: null };
  let layers = { ...DEFAULT_LAYERS };
  let last = null; let data = null; let provisional = null;

  const lineOpts = (color, width = 1.5) => ({ color, lineWidth: width, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false });
  function ensure(key, make) { if (!s[key]) s[key] = make(); return s[key]; }
  function drop(key) { if (s[key]) { chart.removeSeries(s[key]); s[key] = null; } }

  function apply() {
    if (!data) return;
    const ts = data.candles.map(c => sec(c.t));
    ctx.times = ts;
    const indT = data.indicators.times.map(sec);
    const toLine = arr => arr.map((v, k) => (v == null ? { time: indT[k] } : { time: indT[k], value: v }));
    if (layers.ema) {
      ensure('emaF', () => chart.addSeries(LineSeries, lineOpts('#7aa2f7'))).setData(toLine(data.indicators.emaFast));
      ensure('emaS', () => chart.addSeries(LineSeries, lineOpts('#e0af68'))).setData(toLine(data.indicators.emaSlow));
    } else { drop('emaF'); drop('emaS'); }
    if (layers.rsi) {
      const r = ensure('rsi', () => { const x = chart.addSeries(LineSeries, { ...lineOpts('#bb9af7'), lastValueVisible: true }, 1); x.createPriceLine({ price: 70, color: 'rgba(229,83,75,.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: '70' }); x.createPriceLine({ price: 30, color: 'rgba(63,182,139,.6)', lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: '30' }); return x; });
      r.setData(toLine(data.indicators.rsi));
    } else drop('rsi');
    if (layers.volume) {
      const v = ensure('vol', () => chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false }, layers.rsi ? 2 : 1));
      v.setData(data.candles.map(c => ({ time: sec(c.t), value: c.v ?? 0, color: c.c >= c.o ? 'rgba(63,182,139,.45)' : 'rgba(229,83,75,.45)' })));
    } else drop('vol');
    const lv = data.overlays.levelSeries || [];
    const step2 = (key, field, color) => ensure(key, () => chart.addSeries(LineSeries, { ...lineOpts(color, 1), lineType: LineType.WithSteps, lineStyle: LineStyle.Dashed })).setData(lv.map(x => (x[field] == null ? { time: sec(x.t) } : { time: sec(x.t), value: x[field] })));
    if (layers.levels) { step2('pdh', 'pdh', '#9ece6a'); step2('pdl', 'pdl', '#f7768e'); } else { drop('pdh'); drop('pdl'); }
    if (layers.asian) { step2('ah', 'asianHigh', '#73daca'); step2('al', 'asianLow', '#73daca'); } else { drop('ah'); drop('al'); }
    const b = [];
    if (layers.sessions) {
      const col = { london: 'rgba(122,162,247,.06)', newyork: 'rgba(224,175,104,.06)', asianRange: 'rgba(115,218,202,.05)' };
      for (const [k, list] of Object.entries(data.overlays.sessions || {})) for (const x of list) b.push({ start: x.start, end: x.end, color: col[k] || 'rgba(255,255,255,.04)', label: x.label });
    }
    if (layers.blackouts) for (const x of data.overlays.blackouts || []) b.push({ start: x.start, end: x.end, color: 'rgba(163,113,247,.16)', label: `⚠ ${x.currency} ${x.title}`.slice(0, 40), textColor: css('--block') });
    bands.setBands(b);
    // markers
    const m = [];
    const stepMs = step * 1000;
    const barOf = ms => sec(ms - (ms % stepMs));
    const inView = t => ts.length && t >= ts[0] && t <= ts.at(-1) + step;
    for (const sg of data.signals || []) {
      const long = sg.direction === 'LONG';
      // exact op de entryprijs van de gesloten signaalcandle
      m.push({ time: sec(sg.candle_t), position: long ? 'atPriceBottom' : 'atPriceTop', price: sg.entry_ref, color: long ? css('--buy') : css('--sell'), shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'BUY' : 'SELL'} ${px(inst, sg.entry_ref)}${sg.data_kind !== 'real' ? ' (demo)' : ''}` });
      for (const ev of sg.events || []) {
        const t = barOf(ev.at);
        if (!inView(t)) continue;
        if (ev.type === 'EXPIRED' || ev.type === 'CANCELLED' || ev.type === 'ENTRY_MISSED') m.push({ time: t, position: long ? 'belowBar' : 'aboveBar', color: css('--faint'), shape: 'circle', size: 0.6, text: ev.type === 'ENTRY_MISSED' ? 'GEMIST' : ev.type });
      }
    }
    const liveKeys = new Set((data.signals || []).map(sg => sec(sg.candle_t)));
    for (const hsig of data.history || []) {
      const long = hsig.direction === 'LONG'; const t = sec(hsig.signalT);
      if (liveKeys.has(t) || !inView(t)) continue;
      if (hsig.blocked) {
        const why = { SESSION_NOT_ALLOWED: 'buiten sessie', SPREAD_TOO_WIDE_ATR: 'spread', SPREAD_TOO_WIDE_ABS: 'spread', NEWS_BLACKOUT: 'nieuws', RR_BELOW_MIN: 'RR<2', NO_TARGET: 'geen target', COOLDOWN: 'cooldown', MARKET_CLOSED: 'markt dicht', DATA_GAP: 'datagat' }[hsig.blocked[0]] || hsig.blocked[0];
        if (hsig.entryRef != null) m.push({ time: t, position: long ? 'atPriceBottom' : 'atPriceTop', price: hsig.entryRef, color: css('--faint'), shape: long ? 'arrowUp' : 'arrowDown', size: 0.7, text: `${long ? 'BUY' : 'SELL'}? ${why}` });
        continue;
      }
      m.push({ time: t, position: long ? 'atPriceBottom' : 'atPriceTop', price: hsig.entryRef, color: long ? css('--buy') : css('--sell'), shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'BUY' : 'SELL'} ${px(inst, hsig.entryRef)}${hsig.skipped ? ' (gemist)' : ''}` });
      if (hsig.exitT && hsig.status === 'CLOSED' && inView(sec(hsig.exitT))) m.push({ time: sec(hsig.exitT), position: 'atPriceMiddle', price: hsig.exitPx, color: (hsig.rNet ?? 0) >= 0 ? css('--buy') : css('--sell'), shape: 'square', size: 0.7, text: `${hsig.exitReason.startsWith('TP') ? 'TP' : 'SL'} ${hsig.rNet >= 0 ? '+' : ''}${hsig.rNet.toFixed(2)}R` });
    }
    for (const p of data.paper || []) {
      const long = p.direction === 'LONG'; const t = barOf(p.opened_at);
      if (inView(t)) m.push({ time: t, position: 'atPriceMiddle', price: p.entry, color: css('--accent'), shape: 'circle', size: 0.8, text: `Paper ${long ? 'koop' : 'verkoop'} ${px(inst, p.entry)}` });
      if (p.closed_at && inView(barOf(p.closed_at))) m.push({ time: barOf(p.closed_at), position: 'atPriceMiddle', price: p.exit_price, color: (p.realized_r ?? 0) >= 0 ? css('--buy') : css('--sell'), shape: 'square', size: 0.8, text: `${long ? 'EXIT LONG' : 'EXIT SHORT'} ${px(inst, p.exit_price)}${p.realized_r != null ? ` (${p.realized_r >= 0 ? '+' : ''}${p.realized_r.toFixed(2)}R)` : ''}` });
    }
    for (const mk of data.extraMarkers || []) m.push(mk);
    if (layers.structure) {
      const st = data.overlays.structure;
      for (const p of st.pivots.slice(-80)) m.push({ time: sec(p.t), position: p.kind === 'H' ? 'aboveBar' : 'belowBar', color: 'rgba(140,155,176,.7)', shape: 'circle', size: 0.4, text: p.kind === 'H' ? 'sH' : 'sL' });
      for (const sw of st.sweeps.slice(-30)) m.push({ time: sec(sw.t), position: sw.type === 'SWEEP_HIGH' ? 'aboveBar' : 'belowBar', color: css('--wait'), shape: 'circle', size: 0.6, text: `sweep ${sw.level}` });
      for (const br of st.breaks.slice(-30)) m.push({ time: sec(br.t), position: br.type.endsWith('UP') ? 'belowBar' : 'aboveBar', color: br.type.startsWith('MSS') ? css('--block') : 'rgba(140,155,176,.9)', shape: 'square', size: 0.5, text: br.type.replace('_', ' ') });
      for (const g of st.fvgs) b.push({ start: g.t, end: g.t + step * 3000, color: 'rgba(224,175,104,.10)' });
      bands.setBands(b);
    }
    m.sort((a, z) => a.time - z.time);
    markers.setMarkers(m);
    planP.setPlan(layers.plan ? data.plan || null : null);
  }

  function setData(d, { fit = false } = {}) {
    data = d; provisional = null;
    candles.setData(d.candles.map(c => ({ time: sec(c.t), open: c.o, high: c.h, low: c.l, close: c.c, ...(c.complete === false ? { color: 'rgba(140,155,176,.5)', wickColor: 'rgba(140,155,176,.5)' } : {}) })));
    last = d.candles.at(-1) || null;
    apply();
    if (fit) chart.timeScale().scrollToRealTime();
  }

  /** Voorlopige (lopende) candle uit quotes; duidelijk grijs, telt niet mee voor signalen. */
  function setQuote(q) {
    if (!last || !q || q.bid == null) return;
    const mid = (q.bid + q.ask) / 2; const bucket = Math.floor(q.time / (step * 1000)) * step;
    if (bucket <= sec(last.t)) return;
    if (!provisional || provisional.time !== bucket) provisional = { time: bucket, open: last.c, high: Math.max(last.c, mid), low: Math.min(last.c, mid), close: mid };
    provisional.high = Math.max(provisional.high, mid); provisional.low = Math.min(provisional.low, mid); provisional.close = mid;
    candles.update({ ...provisional, color: 'rgba(140,155,176,.45)', wickColor: 'rgba(140,155,176,.45)' });
  }

  function onCrosshair(fn) {
    chart.subscribeCrosshairMove(p => {
      if (!p.time || !data) { fn(null); return; }
      const c = data.candles.find(x => sec(x.t) === p.time);
      const k = data.indicators.times.findIndex(t => sec(t) === p.time);
      fn(c ? { c, emaF: data.indicators.emaFast[k], emaS: data.indicators.emaSlow[k], rsi: data.indicators.rsi[k] } : null);
    });
  }

  return {
    setData, setQuote, onCrosshair,
    setLayers(l) { layers = { ...layers, ...l }; apply(); },
    scrollTo(ms) { const t = sec(ms); const k = ctx.times.findIndex(x => x >= t); if (k >= 0) chart.timeScale().setVisibleLogicalRange({ from: k - 60, to: k + 40 }); },
    destroy() { chart.remove(); },
    chart,
  };
}
