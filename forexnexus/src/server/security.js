// Beveiliging: versleutelde secrets, wachtwoordcontrole, sessies, CSRF en
// ondertekende worker-requests met replaybescherming.

import { randomBytes, createCipheriv, createDecipheriv, createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------- master key ----------

/**
 * Master key voor AES-256-GCM. Voorkeur: FNX_MASTER_KEY (base64, 32 bytes) als
 * runtime secret. Zonder variabele wordt een sleutelbestand naast de database
 * aangemaakt (rechten 0600) — buiten git, maar wel op hetzelfde volume.
 */
export function loadMasterKey(env, keyFile) {
  if (env.FNX_MASTER_KEY) {
    const k = Buffer.from(env.FNX_MASTER_KEY, 'base64');
    if (k.length !== 32) throw new Error('FNX_MASTER_KEY moet 32 bytes (base64) zijn');
    return { key: k, source: 'env' };
  }
  if (keyFile) {
    if (existsSync(keyFile)) return { key: Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64'), source: 'file' };
    mkdirSync(dirname(keyFile), { recursive: true });
    const k = randomBytes(32);
    writeFileSync(keyFile, k.toString('base64'), { mode: 0o600 });
    return { key: k, source: 'file-generated' };
  }
  throw new Error('Geen master key beschikbaar');
}

export function encrypt(key, plaintext) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function decrypt(key, { ciphertext, iv, tag }) {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ciphertext, 'base64')), d.final()]).toString('utf8');
}

/** Secret-opslag. `hint` toont alleen de laatste 4 tekens, nooit de waarde. */
export function secretStore(db, key) {
  return {
    set(name, value) {
      const v = String(value ?? '');
      if (!v) return false; // leeg veld wist een bestaand secret NIET
      const enc = encrypt(key, v);
      const hint = v.length > 8 ? `••••${v.slice(-4)}` : '••••';
      db.run('INSERT INTO secrets (name, ciphertext, iv, tag, hint, updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag, hint=excluded.hint, updated_at=excluded.updated_at', name, enc.ciphertext, enc.iv, enc.tag, hint, Date.now());
      return true;
    },
    get(name) {
      const r = db.get('SELECT * FROM secrets WHERE name = ?', name);
      return r ? decrypt(key, r) : null;
    },
    remove(name) { db.run('DELETE FROM secrets WHERE name = ?', name); },
    status() {
      return Object.fromEntries(db.all('SELECT name, hint, updated_at FROM secrets').map(r => [r.name, { set: true, hint: r.hint, updatedAt: r.updated_at }]));
    },
  };
}

// ---------- wachtwoord ----------

export function hashPassword(pw, salt = randomBytes(16)) {
  const h = scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('base64')}$${h.toString('base64')}`;
}

export function verifyPassword(pw, stored) {
  if (!stored) return false;
  if (stored.startsWith('scrypt$')) {
    const [, salt, hash] = stored.split('$');
    const h = scryptSync(String(pw), Buffer.from(salt, 'base64'), 32);
    const exp = Buffer.from(hash, 'base64');
    return h.length === exp.length && timingSafeEqual(h, exp);
  }
  // platte tekst in env (bijv. FNX_ACCESS_PASSWORD): constante-tijdvergelijking via hash
  const a = createHash('sha256').update(String(pw)).digest();
  const b = createHash('sha256').update(String(stored)).digest();
  return timingSafeEqual(a, b);
}

// ---------- sessies + CSRF ----------

export const sha256 = s => createHash('sha256').update(String(s)).digest('hex');

export function createSession(db, ttlMs = 30 * 86_400_000) {
  const id = randomBytes(32).toString('base64url');
  const csrf = randomBytes(24).toString('base64url');
  const now = Date.now();
  db.run('INSERT INTO sessions (id_hash, csrf, created_at, expires_at) VALUES (?,?,?,?)', sha256(id), csrf, now, now + ttlMs);
  return { id, csrf, expiresAt: now + ttlMs };
}

export function getSession(db, id) {
  if (!id) return null;
  const r = db.get('SELECT * FROM sessions WHERE id_hash = ?', sha256(id));
  if (!r || r.expires_at < Date.now()) return null;
  return r;
}

export function destroySession(db, id) {
  if (id) db.run('DELETE FROM sessions WHERE id_hash = ?', sha256(id));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---------- worker-authenticatie (HMAC + timestamp + nonce) ----------

export function signWorkerRequest(secret, { method, path, body = '', ts = Date.now(), nonce = randomBytes(16).toString('hex') }) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  const sig = createHmac('sha256', secret).update(`${ts}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`).digest('hex');
  return { 'x-fnx-timestamp': String(ts), 'x-fnx-nonce': nonce, 'x-fnx-signature': sig };
}

/** Verifieer een ondertekend worker-request. Nonces worden 10 minuten bewaard. */
export function verifyWorkerRequest(db, secret, { method, path, body = '', headers }, now = Date.now(), maxSkewMs = 60_000) {
  if (!secret) return { ok: false, code: 'WORKER_SECRET_NOT_SET' };
  const ts = Number(headers['x-fnx-timestamp']); const nonce = headers['x-fnx-nonce']; const sig = headers['x-fnx-signature'];
  if (!ts || !nonce || !sig) return { ok: false, code: 'MISSING_HEADERS' };
  if (!/^[a-f0-9]{16,64}$/.test(nonce)) return { ok: false, code: 'BAD_NONCE' };
  if (Math.abs(now - ts) > maxSkewMs) return { ok: false, code: 'EXPIRED' };
  const exp = signWorkerRequest(secret, { method, path, body, ts, nonce })['x-fnx-signature'];
  const a = Buffer.from(exp, 'hex'); const b = Buffer.from(String(sig), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'BAD_SIGNATURE' };
  db.run('DELETE FROM worker_nonces WHERE at < ?', now - 10 * 60_000);
  try { db.run('INSERT INTO worker_nonces (nonce, at) VALUES (?, ?)', nonce, now); }
  catch { return { ok: false, code: 'REPLAY' }; }
  return { ok: true };
}

/** Verwijder gevoelige waarden uit willekeurige tekst (logs, foutmeldingen). */
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of secrets) if (v && v.length >= 6) s = s.split(v).join('[verborgen]');
  s = s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot[verborgen]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [verborgen]');
  return s;
}
