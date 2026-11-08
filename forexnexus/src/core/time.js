// Tijdhulpmiddelen. Alle opslag en berekening gebeurt in UTC-milliseconden.
// Lokale tijden (Europe/Brussels, Europe/London, America/New_York) worden
// uitsluitend via de IANA-tijdzonedatabase van Intl afgeleid, zodat
// zomer-/wintertijdovergangen per regio correct verlopen.

export const MIN = 60_000;
export const TF_MS = Object.freeze({
  M1: 1 * MIN,
  M5: 5 * MIN,
  M15: 15 * MIN,
  H1: 60 * MIN,
  H4: 240 * MIN,
});
export const TIMEFRAMES = Object.keys(TF_MS);

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Lokale kalenderdelen van een UTC-moment in tijdzone tz. */
export function zoned(ms, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  const hour = Number(out.hour) % 24;
  return {
    year: Number(out.year), month: Number(out.month), day: Number(out.day),
    hour, minute: Number(out.minute), second: Number(out.second),
    weekday: WD[out.weekday],
    minuteOfDay: hour * 60 + Number(out.minute),
    dateKey: `${out.year}-${out.month}-${out.day}`,
  };
}

/** Offset (ms) van tz t.o.v. UTC op moment ms. */
export function tzOffset(ms, tz) {
  const z = zoned(ms, tz);
  const asUtc = Date.UTC(z.year, z.month - 1, z.day, z.hour, z.minute, z.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Converteer een lokale wandklok-tijd in tz naar UTC-ms (DST-bewust). */
export function localToUtc(year, month, day, hour, minute, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ms = guess - tzOffset(guess, tz);
  // tweede iteratie corrigeert rond DST-overgangen
  ms = guess - tzOffset(ms, tz);
  return ms;
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) throw new Error(`Ongeldige tijd: ${s}`);
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 24 || mi > 59) throw new Error(`Ongeldige tijd: ${s}`);
  return h * 60 + mi;
}

export function floorTf(ms, tf) {
  const step = TF_MS[tf];
  if (!step) throw new Error(`Onbekend tijdframe ${tf}`);
  return Math.floor(ms / step) * step;
}

/** Volgende candlegrens strikt na ms. */
export function nextBoundary(ms, tf) {
  return floorTf(ms, tf) + TF_MS[tf];
}

export function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

const displayCache = new Map();
export function fmtLocal(ms, tz = 'Europe/Brussels', withSeconds = false) {
  if (ms == null) return '—';
  const key = `${tz}|${withSeconds}`;
  let f = displayCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('nl-BE', {
      timeZone: tz, hourCycle: 'h23', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}),
    });
    displayCache.set(key, f);
  }
  return f.format(new Date(ms));
}

export function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? Math.round(v * 1000) : v; // seconden of ms
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
  }
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
