// Economische kalender. Bron 1: de publieke weekfeed van ForexFactory
// (nfs.faireconomy.media/ff_calendar_thisweek.json) voor classificatie en
// tijden van geplande publicaties. Gebruiksrechten van deze feed zijn niet
// formeel bevestigd; feitelijke besluiten en cijfers horen gecontroleerd te
// worden bij de officiële bronnen (Fed, ECB, BoE, BoJ, BLS, BEA).
// De feed bevat de huidige week; buiten die week is de kalender NIET dekkend.
// Onverwachte headlines worden door een kalender niet bewaakt.

import { createHash } from 'node:crypto';
import { classify, OFFICIAL_SOURCES } from '../core/news.js';
import { heartbeat } from '../store/db.js';
import { localToUtc, zoned } from '../core/time.js';

export const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
export const CALENDAR_COVERAGE_TEXT = 'Gepland macronieuws (kalender) voor USD, EUR, GBP, JPY e.a. Geen onverwachte headlines, geen geopolitiek, geen bedrijfsnieuws.';

export function parseFF(json, fetchedAt) {
  const events = [];
  for (const e of Array.isArray(json) ? json : []) {
    const t = Date.parse(e.date);
    if (!Number.isFinite(t) || !e.country || !e.title) continue;
    const allDay = /T00:00:00/.test(e.date) && /holiday|bank holiday/i.test(e.impact + e.title);
    events.push({
      id: createHash('sha1').update(`ff|${e.country}|${e.title}|${e.date}`).digest('hex').slice(0, 20),
      source: 'forexfactory-weekfeed', title: String(e.title).slice(0, 200), currency: String(e.country).slice(0, 8),
      impact: ['High', 'Medium', 'Low', 'Holiday'].includes(e.impact) ? e.impact : 'Unknown',
      category: classify(e.title), time: t, allDay,
      forecast: e.forecast || null, previous: e.previous || null, actual: e.actual || null, url: null, fetchedAt,
    });
  }
  if (!events.length) return { events, coverage: null };
  // dekking: zondag 00:00 ET van de week van het eerste event tot zondag erna
  const first = Math.min(...events.map(e => e.time));
  const z = zoned(first, 'America/New_York');
  const sun = new Date(Date.UTC(z.year, z.month - 1, z.day - z.weekday));
  const next = new Date(Date.UTC(z.year, z.month - 1, z.day - z.weekday + 7));
  const from = localToUtc(sun.getUTCFullYear(), sun.getUTCMonth() + 1, sun.getUTCDate(), 0, 0, 'America/New_York');
  const to = localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 'America/New_York');
  return { events, coverage: { from, to } };
}

export async function refreshCalendar(db, { fetchImpl = fetch, now = Date.now(), url = FF_URL } = {}) {
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const { events, coverage } = parseFF(json, now);
    if (!coverage) throw new Error('Lege kalender ontvangen');
    db.tx(() => {
      for (const e of events) {
        db.run('INSERT INTO calendar_events (id, source, title, currency, impact, category, time, all_day, forecast, previous, actual, url, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET impact=excluded.impact, forecast=excluded.forecast, previous=excluded.previous, actual=excluded.actual, fetched_at=excluded.fetched_at', e.id, e.source, e.title, e.currency, e.impact, e.category, e.time, e.allDay ? 1 : 0, e.forecast, e.previous, e.actual, e.url, now);
      }
      db.run('INSERT INTO calendar_fetches (source, fetched_at, ok, coverage_from, coverage_to, count) VALUES (?,?,?,?,?,?)', 'forexfactory-weekfeed', now, 1, coverage.from, coverage.to, events.length);
    });
    heartbeat(db, 'calendar', 'ok', { count: events.length, coverage }, now);
    return { ok: true, count: events.length, coverage };
  } catch (e) {
    db.run('INSERT INTO calendar_fetches (source, fetched_at, ok, error) VALUES (?,?,?,?)', 'forexfactory-weekfeed', now, 0, String(e.message).slice(0, 300));
    heartbeat(db, 'calendar', 'error', { error: String(e.message).slice(0, 300) }, now);
    return { ok: false, error: e.message };
  }
}

/** Kalenderobject zoals de evaluator het verwacht (uit de database). */
export function loadCalendar(db, now = Date.now()) {
  const f = db.get('SELECT * FROM calendar_fetches WHERE ok = 1 ORDER BY fetched_at DESC LIMIT 1');
  if (!f) return null;
  // import (CSV) kan extra dekking toevoegen
  const imp = db.get("SELECT value FROM settings WHERE key = 'calendar.importCoverage'");
  const coverage = { from: f.coverage_from, to: f.coverage_to };
  const events = db.all('SELECT * FROM calendar_events WHERE time >= ? AND time <= ? ORDER BY time', Math.min(coverage.from, now - 2 * 86_400_000), Math.max(coverage.to, now + 7 * 86_400_000))
    .map(r => ({ ...r, allDay: !!r.all_day }));
  return { source: f.source, fetchedAt: f.fetched_at, coverage, events, importCoverage: imp ? JSON.parse(imp.value) : null, official: OFFICIAL_SOURCES, coverageText: CALENDAR_COVERAGE_TEXT };
}

/** Historische kalender (CSV-import) voor backtests met nieuwsfilter. */
export function calendarForRange(db, from, to) {
  const cov = db.get("SELECT value FROM settings WHERE key = 'calendar.importCoverage'");
  if (!cov) return null;
  const c = JSON.parse(cov.value);
  if (c.from > from || c.to < to) return null;
  const events = db.all('SELECT * FROM calendar_events WHERE time >= ? AND time <= ? ORDER BY time', from - 86_400_000, to + 86_400_000).map(r => ({ ...r, allDay: !!r.all_day }));
  return { source: 'import', fetchedAt: to, coverage: c, events };
}
