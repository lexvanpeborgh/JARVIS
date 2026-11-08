// Gecontroleerde import van historische candles (CSV of Parquet) met
// herkomstregistratie, checksum en datakwaliteitsrapport. Imports worden
// gevalideerd vóór een backtest kan starten.

import { createHash, randomUUID } from 'node:crypto';
import { parseTime, TF_MS, iso } from '../core/time.js';
import { validateCandles } from '../core/quality.js';
import { getInstrument } from '../core/instruments.js';
import { upsertCandles } from '../store/db.js';

const ALIASES = {
  t: ['time', 'timestamp', 'datetime', 'date', 't', 'open_time'],
  o: ['open', 'o', 'mid_o'], h: ['high', 'h', 'mid_h'], l: ['low', 'l', 'mid_l'], c: ['close', 'c', 'mid_c'],
  bo: ['bid_open', 'bo', 'bid_o'], bh: ['bid_high', 'bh', 'bid_h'], bl: ['bid_low', 'bl', 'bid_l'], bc: ['bid_close', 'bc', 'bid_c'],
  ao: ['ask_open', 'ao', 'ask_o'], ah: ['ask_high', 'ah', 'ask_h'], al: ['ask_low', 'al', 'ask_l'], ac: ['ask_close', 'ac', 'ask_c'],
  v: ['volume', 'v', 'tick_volume', 'vol'], complete: ['complete'], contract: ['contract', 'symbol'],
};

function mapHeader(cols) {
  const lower = cols.map(c => c.trim().toLowerCase());
  const idx = {};
  for (const [k, names] of Object.entries(ALIASES)) {
    const i = lower.findIndex(c => names.includes(c));
    if (i >= 0) idx[k] = i;
  }
  return idx;
}

export function parseCsv(text) {
  const lines = String(text).replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return { header: [], rows: [] };
  const sep = lines[0].includes(';') && !lines[0].includes(',') ? ';' : lines[0].includes('\t') ? '\t' : ',';
  const header = lines[0].split(sep).map(s => s.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(l => l.split(sep).map(s => s.trim().replace(/^"|"$/g, '')));
  return { header, rows };
}

export function rowsToCandles(header, rows, { tzOffsetMinutes = 0, volumeType = 'none', kind = 'real', src = 'csv' } = {}) {
  const idx = mapHeader(header);
  const errors = [];
  if (idx.t == null) errors.push('Kolom met tijd ontbreekt (time/timestamp/datetime).');
  const hasMid = ['o', 'h', 'l', 'c'].every(k => idx[k] != null);
  const hasBA = ['bo', 'bh', 'bl', 'bc', 'ao', 'ah', 'al', 'ac'].every(k => idx[k] != null);
  if (!hasMid && !hasBA) errors.push('OHLC-kolommen ontbreken (open/high/low/close of bid_*/ask_*).');
  if (errors.length) return { candles: [], errors, priceType: null };
  const n = x => (x === undefined || x === '' ? null : Number(String(x).replace(',', '.')));
  const candles = [];
  for (const r of rows) {
    let t = parseTime(r[idx.t]);
    if (t == null) { errors.push(`Ongeldige tijd: ${r[idx.t]}`); continue; }
    // tijden zonder zone-aanduiding worden geïnterpreteerd met de opgegeven offset
    if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(String(r[idx.t])) && !/^\d+$/.test(String(r[idx.t]))) t -= tzOffsetMinutes * 60_000;
    const c = { t, src, kind, vType: idx.v != null ? volumeType : 'none', complete: idx.complete != null ? String(r[idx.complete]).toLowerCase() !== 'false' : true };
    if (hasBA) {
      c.b = { o: n(r[idx.bo]), h: n(r[idx.bh]), l: n(r[idx.bl]), c: n(r[idx.bc]) };
      c.a = { o: n(r[idx.ao]), h: n(r[idx.ah]), l: n(r[idx.al]), c: n(r[idx.ac]) };
    }
    if (hasMid) { c.o = n(r[idx.o]); c.h = n(r[idx.h]); c.l = n(r[idx.l]); c.c = n(r[idx.c]); }
    else { c.o = (c.b.o + c.a.o) / 2; c.h = (c.b.h + c.a.h) / 2; c.l = (c.b.l + c.a.l) / 2; c.c = (c.b.c + c.a.c) / 2; }
    c.v = idx.v != null ? n(r[idx.v]) : null;
    if (idx.contract != null) c.contract = r[idx.contract];
    candles.push(c);
  }
  return { candles, errors: errors.slice(0, 50), priceType: hasBA ? 'BA' : 'M' };
}

export async function parseParquet(buffer) {
  const { parquetReadObjects } = await import('hyparquet');
  const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const objs = await parquetReadObjects({ file: ab });
  if (!objs.length) return { header: [], rows: [] };
  const header = Object.keys(objs[0]);
  const rows = objs.map(o => header.map(h => { const v = o[h]; return v instanceof Date ? v.toISOString() : typeof v === 'bigint' ? String(v) : v; }));
  return { header, rows };
}

/**
 * Importeer naar een dataset. Retourneert het datakwaliteitsrapport.
 * `meta.kind` = 'real' (echte historische data) of 'synthetic'.
 */
export async function importDataset(db, { buffer, filename = 'upload.csv', instrument, timeframe = 'M5', source = 'csv', provider = null, volumeType = 'none', tzOffsetMinutes = 0, kind = 'real', contract = null }) {
  const inst = getInstrument(instrument);
  if (!TF_MS[timeframe]) throw new Error('Ongeldig tijdframe');
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const dup = db.get('SELECT id FROM datasets WHERE checksum = ? AND instrument = ? AND timeframe = ?', checksum, instrument, timeframe);
  if (dup) return { ok: false, duplicate: true, datasetId: dup.id, text: 'Dit bestand is al geïmporteerd.' };
  const isParquet = /\.parquet$/i.test(filename);
  const { header, rows } = isParquet ? await parseParquet(buffer) : parseCsv(buffer.toString('utf8'));
  const parsed = rowsToCandles(header, rows, { tzOffsetMinutes, volumeType, kind, src: isParquet ? 'parquet' : 'csv' });
  if (!parsed.candles.length) return { ok: false, errors: parsed.errors, text: 'Geen geldige candles gevonden.' };
  if (contract) for (const c of parsed.candles) c.contract = c.contract || contract;
  const v = validateCandles(parsed.candles, { inst, tf: timeframe, maxSpreadPrice: inst.pip ? inst.pip * 20 : null });
  const id = randomUUID();
  const quality = { ...v.report, parseErrors: parsed.errors, issues: v.issues.slice(0, 500), gaps: v.gaps.slice(0, 500).map(g => ({ from: iso(g.from), to: iso(g.to), missing: g.missing })) };
  db.run('INSERT INTO datasets (id, source, provider, instrument, contract, timeframe, price_type, volume_type, timezone, from_t, to_t, rows, checksum, kind, filename, corrections, quality, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, source, provider, instrument, contract, timeframe, parsed.priceType, parsed.candles[0].vType, `UTC${tzOffsetMinutes >= 0 ? '+' : ''}${tzOffsetMinutes / 60}`, v.clean[0]?.t ?? null, v.clean.at(-1)?.t ?? null, v.clean.length, checksum, kind, filename,
    JSON.stringify(['Ongeldige/dubbele candles uitgesloten, niet gerepareerd', 'Gaten niet opgevuld']), JSON.stringify(quality), Date.now());
  upsertCandles(db, id, instrument, timeframe, v.clean);
  return { ok: true, datasetId: id, quality };
}

/** Registreer een providerimport (bijv. OANDA) als dataset met herkomst. */
export function registerProviderDataset(db, { instrument, timeframe, provider, candles, env }) {
  const inst = getInstrument(instrument);
  const v = validateCandles(candles, { inst, tf: timeframe, maxSpreadPrice: inst.pip ? inst.pip * 20 : null });
  const id = `${provider}-${env || 'x'}-${instrument}-${timeframe}-${v.clean[0]?.t ?? 0}-${v.clean.at(-1)?.t ?? 0}`;
  const checksum = createHash('sha256').update(JSON.stringify(v.clean.map(c => [c.t, c.o, c.h, c.l, c.c, c.v]))).digest('hex');
  db.run('INSERT OR REPLACE INTO datasets (id, source, provider, instrument, contract, timeframe, price_type, volume_type, timezone, from_t, to_t, rows, checksum, kind, filename, corrections, quality, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    id, provider, `${provider}:${env || ''}`, instrument, null, timeframe, 'BA', 'tick_count', 'UTC', v.clean[0]?.t ?? null, v.clean.at(-1)?.t ?? null, v.clean.length, checksum, 'real', null, JSON.stringify(['Onvolledige candles uitgesloten']), JSON.stringify({ ...v.report, issues: v.issues.slice(0, 500) }), Date.now());
  upsertCandles(db, id, instrument, timeframe, v.clean);
  return { datasetId: id, quality: v.report };
}
