// SQLite-opslag via node:sqlite (ingebouwd in Node ≥ 22.13). WAL-modus voor
// gelijktijdige lezers. Migrations draaien idempotent bij het opstarten.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function openDb(file = ':memory:') {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(r => r.name));
  for (const f of readdirSync(MIGRATIONS).filter(x => x.endsWith('.sql')).sort()) {
    if (applied.has(f)) continue;
    db.exec('BEGIN');
    try {
      db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return wrap(db);
}

function wrap(db) {
  const cache = new Map();
  const stmt = sql => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  return {
    raw: db,
    run: (sql, ...p) => stmt(sql).run(...p),
    get: (sql, ...p) => stmt(sql).get(...p),
    all: (sql, ...p) => stmt(sql).all(...p),
    exec: sql => db.exec(sql),
    tx(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* al teruggedraaid */ } throw e; }
    },
    close: () => db.close(),
  };
}

// ---------- helpers ----------

export function getSetting(db, key, fallback = null) {
  const r = db.get('SELECT value FROM settings WHERE key = ?', key);
  return r ? JSON.parse(r.value) : fallback;
}

export function setSetting(db, key, value) {
  db.run('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', key, JSON.stringify(value), Date.now());
}

export function heartbeat(db, kind, status, detail = null, at = Date.now()) {
  db.run('INSERT INTO heartbeats (kind, at, status, detail) VALUES (?, ?, ?, ?)', kind, at, status, detail == null ? null : JSON.stringify(detail));
}

export function lastHeartbeat(db, kind, status = null) {
  const r = status
    ? db.get('SELECT * FROM heartbeats WHERE kind = ? AND status = ? ORDER BY at DESC LIMIT 1', kind, status)
    : db.get('SELECT * FROM heartbeats WHERE kind = ? ORDER BY at DESC LIMIT 1', kind);
  return r ? { ...r, detail: r.detail ? JSON.parse(r.detail) : null } : null;
}

export function setState(db, key, value) {
  db.run('INSERT INTO engine_state (key, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at', key, JSON.stringify(value), Date.now());
}

export function getState(db, key, fallback = null) {
  const r = db.get('SELECT json, updated_at FROM engine_state WHERE key = ?', key);
  return r ? JSON.parse(r.json) : fallback;
}

/** Lease tegen dubbele workers. Retourneert true als `owner` de lease houdt. */
export function acquireLease(db, name, owner, ttlMs, now = Date.now()) {
  return db.tx(() => {
    const cur = db.get('SELECT owner, expires_at FROM leases WHERE name = ?', name);
    if (!cur) { db.run('INSERT INTO leases (name, owner, expires_at) VALUES (?, ?, ?)', name, owner, now + ttlMs); return true; }
    if (cur.owner === owner || cur.expires_at < now) { db.run('UPDATE leases SET owner = ?, expires_at = ? WHERE name = ?', owner, now + ttlMs, name); return true; }
    return false;
  });
}

export function releaseLease(db, name, owner) {
  db.run('DELETE FROM leases WHERE name = ? AND owner = ?', name, owner);
}

// ---------- candles ----------

export function rowToCandle(r) {
  const c = { t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, vType: r.v_type, complete: !!r.complete, contract: r.contract || undefined };
  if (r.bo != null && r.ao != null) { c.b = { o: r.bo, h: r.bh, l: r.bl, c: r.bc }; c.a = { o: r.ao, h: r.ah, l: r.al, c: r.ac }; }
  return c;
}

/**
 * Upsert met revisiebeheer: een gewijzigde, eerder opgeslagen gesloten candle
 * krijgt revision+1 en een datakwaliteitsmelding (historische correctie).
 */
export function upsertCandles(db, datasetId, instrument, tf, candles, receivedAt = Date.now()) {
  let inserted = 0; let revised = 0; let unchanged = 0;
  db.tx(() => {
    for (const c of candles) {
      const prev = db.get('SELECT * FROM candles WHERE dataset_id = ? AND instrument = ? AND timeframe = ? AND t = ?', datasetId, instrument, tf, c.t);
      const vals = [c.o, c.h, c.l, c.c, c.b?.o ?? null, c.b?.h ?? null, c.b?.l ?? null, c.b?.c ?? null, c.a?.o ?? null, c.a?.h ?? null, c.a?.l ?? null, c.a?.c ?? null, c.v ?? null, c.vType || null, c.complete === false ? 0 : 1, c.contract || null];
      if (!prev) {
        db.run('INSERT INTO candles (dataset_id, instrument, timeframe, t, o, h, l, c, bo, bh, bl, bc, ao, ah, al, ac, v, v_type, complete, contract, received_at, revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)', datasetId, instrument, tf, c.t, ...vals, receivedAt);
        inserted += 1; continue;
      }
      const same = prev.o === c.o && prev.h === c.h && prev.l === c.l && prev.c === c.c && (prev.v ?? null) === (c.v ?? null) && prev.complete === (c.complete === false ? 0 : 1);
      if (same) { unchanged += 1; continue; }
      const wasComplete = prev.complete === 1;
      db.run('UPDATE candles SET o=?, h=?, l=?, c=?, bo=?, bh=?, bl=?, bc=?, ao=?, ah=?, al=?, ac=?, v=?, v_type=?, complete=?, contract=?, received_at=?, revision=revision+1 WHERE dataset_id=? AND instrument=? AND timeframe=? AND t=?', ...vals, receivedAt, datasetId, instrument, tf, c.t);
      if (wasComplete) {
        revised += 1;
        db.run('INSERT INTO data_quality (at, dataset_id, instrument, type, detail) VALUES (?,?,?,?,?)', receivedAt, datasetId, instrument, 'REVISION', JSON.stringify({ t: c.t, before: { o: prev.o, h: prev.h, l: prev.l, c: prev.c, v: prev.v }, after: { o: c.o, h: c.h, l: c.l, c: c.c, v: c.v } }));
      }
    }
  });
  return { inserted, revised, unchanged };
}

export function loadCandles(db, datasetId, instrument, tf, { from = 0, to = 8.64e15, limit = 100000 } = {}) {
  const rows = db.all('SELECT * FROM candles WHERE dataset_id = ? AND instrument = ? AND timeframe = ? AND t >= ? AND t < ? ORDER BY t DESC LIMIT ?', datasetId, instrument, tf, from, to, limit);
  return rows.reverse().map(rowToCandle);
}
